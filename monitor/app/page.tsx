import { redirect } from "next/navigation";
import { AccessDenied } from "@/components/access-denied";
import { LoginScreen } from "@/components/login-screen";
import { MonitorDashboard } from "@/components/monitor-dashboard";
import { readPageAuth } from "@/lib/auth/session";
import { collectHealthSnapshot } from "@/lib/health";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ auth?: string }>;
};

export default async function Page({ searchParams }: PageProps) {
  const auth = await readPageAuth();
  if (auth.status === "expired") redirect("/auth/renew");
  if (auth.status === "signed_out") {
    return <LoginScreen authMessage={(await searchParams).auth} />;
  }
  if (auth.status === "denied") return <AccessDenied user={auth.user} />;

  const snapshot = await collectHealthSnapshot();
  return <MonitorDashboard initialSnapshot={snapshot} user={auth.user} />;
}
