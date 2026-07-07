/** Image files a paste carries, extracted the way WKWebView actually
 * delivers them: prefer DataTransferItems (screenshots), fall back to
 * `files`, filter to image types (Finder file copies arrive as pasteboard
 * URLs, never as Files), collapse same-image multi-representation pastes to
 * the best one, and give nameless pastes a stable name. Shared by the chat
 * composer and the issue report dialog. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const itemFiles =
    data.items && data.items.length
      ? Array.from(data.items)
          .filter((item) => item.kind === "file" && isClipboardImageType(item.type))
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file))
      : [];
  if (itemFiles.length) return normalizeClipboardImageFiles(itemFiles);
  return normalizeClipboardImageFiles(
    Array.from(data.files ?? []).filter((file) => isClipboardImageType(file.type)),
  );
}

function normalizeClipboardImageFiles(files: File[]): File[] {
  if (files.length <= 1 || hasDistinctClipboardFileNames(files)) {
    return files.map(ensureClipboardImageName);
  }
  const best = [...files].sort(
    (left, right) => clipboardImageRank(right) - clipboardImageRank(left),
  )[0];
  return best ? [ensureClipboardImageName(best, 0)] : [];
}

function hasDistinctClipboardFileNames(files: File[]) {
  const names = files.map((file) => file.name.trim()).filter(Boolean);
  const stems = names.map(clipboardImageStem);
  return (
    names.length === files.length &&
    new Set(names).size === files.length &&
    new Set(stems).size === files.length
  );
}

function ensureClipboardImageName(file: File, index: number) {
  if (file.name.trim()) return file;
  const suffix = index === 0 ? "" : `-${index + 1}`;
  return new File([file], `pasted-image${suffix}.${clipboardImageExtension(file)}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function isClipboardImageType(type: string) {
  const mimeType = normalizedImageMimeType(type);
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg" ||
    mimeType === "image/tiff" ||
    mimeType === "image/tif" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  );
}

function clipboardImageExtension(file: File) {
  const mimeType = normalizedImageMimeType(file.type);
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/tiff" || mimeType === "image/tif") return "tiff";
  const subtype = mimeType.startsWith("image/") ? mimeType.slice(6) : "";
  return subtype.replace(/[^a-z0-9]/g, "") || "png";
}

function clipboardImageStem(name: string) {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

function clipboardImageRank(file: File) {
  const mimeType = normalizedImageMimeType(file.type);
  if (mimeType === "image/png") return 50;
  if (mimeType === "image/tiff" || mimeType === "image/tif") return 40;
  if (mimeType === "image/webp") return 30;
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return 20;
  if (mimeType === "image/gif") return 10;
  return 1;
}

function normalizedImageMimeType(type: string) {
  return type.toLowerCase().split(";")[0];
}
