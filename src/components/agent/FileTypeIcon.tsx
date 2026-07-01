import { IconFileChart } from "central-icons/IconFileChart";
import { IconFileJpg } from "central-icons/IconFileJpg";
import { IconFilePdf } from "central-icons/IconFilePdf";
import { IconFilePng } from "central-icons/IconFilePng";
import { IconFileText } from "central-icons/IconFileText";
import { IconFileZip } from "central-icons/IconFileZip";

// File-type glyphs come straight from the icon set — no hand-drawn fallbacks.
// Extensions without a dedicated glyph map onto the closest fit (other images
// → PNG, other archives → ZIP, spreadsheets → chart); anything unknown reads
// as a generic text file.
const EXTENSION_ICONS: Record<string, typeof IconFileText> = {
  pdf: IconFilePdf,
  png: IconFilePng,
  gif: IconFilePng,
  webp: IconFilePng,
  svg: IconFilePng,
  heic: IconFilePng,
  jpg: IconFileJpg,
  jpeg: IconFileJpg,
  zip: IconFileZip,
  tar: IconFileZip,
  gz: IconFileZip,
  tgz: IconFileZip,
  rar: IconFileZip,
  "7z": IconFileZip,
  csv: IconFileChart,
  tsv: IconFileChart,
  xls: IconFileChart,
  xlsx: IconFileChart,
  numbers: IconFileChart,
};

/** The icon component matching a file's type, derived from its extension.
 * Accepts a bare filename or a full path. */
export function fileTypeIconComponent(nameOrPath: string): typeof IconFileText {
  const extension = nameOrPath.slice(nameOrPath.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_ICONS[extension] ?? IconFileText;
}

/** Renders the file-type glyph for a filename. */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const Icon = fileTypeIconComponent(name);
  return <Icon size={size} />;
}
