import "server-only";

import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { getServerEnv } from "@/lib/env/server";

export type ApiEnvelope<T> = {
  data: T | null;
  success: boolean;
  error_code?: number;
  message?: string;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  authorization?: string;
  requestId?: string;
};

export async function requestAccountsApi<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
  const url = accountsApiUrl(path);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-request-id": options.requestId ?? randomUUID(),
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body).toString();
  }
  if (options.authorization) headers.authorization = options.authorization;

  return requestJson<ApiEnvelope<T>>(url, {
    method: options.method ?? "GET",
    headers,
    body,
  });
}

function accountsApiUrl(path: string): URL {
  const base = new URL(`${getServerEnv().OS_ACCOUNTS_API_URL}/`);
  const target = new URL(base);
  const relative = path.startsWith("/") ? path : `/${path}`;
  const queryIndex = relative.indexOf("?");
  target.pathname = queryIndex === -1 ? relative : relative.slice(0, queryIndex);
  target.search = queryIndex === -1 ? "" : relative.slice(queryIndex);
  if (target.origin !== base.origin) throw new Error("OS Accounts URL escaped configured origin");
  return target;
}

function requestJson<T>(
  url: URL,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: options.method, headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
