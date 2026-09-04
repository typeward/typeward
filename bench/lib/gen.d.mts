export interface BookOptions {
  chapters?: number;
  sectionsPerChapter?: number;
  paragraphsPerSection?: number;
  equationsPerChapter?: number;
  tablesPerChapter?: number;
  bibEntries?: number;
  proceedings?: number;
  figures?: boolean;
  figureCount?: number;
  biblatex?: boolean;
  wrap?: number;
  seed?: number;
  name?: string;
}

export function mulberry32(seed: number): () => number;
export function wrapText(text: string, width: number): string[];
export function generateBib(opts: { entries: number; proceedings?: number; seed: number }): string;
export function generatePng(opts: { width: number; height: number; seed: number }): Uint8Array;
export function generateBook(opts?: BookOptions): Map<string, string | Uint8Array>;
export function generateLongChapterText(opts: { lines: number; seed?: number; wrap?: number }): string;
export function generateLongChapterProject(opts?: {
  lines?: number;
  seed?: number;
  name?: string;
}): Map<string, string | Uint8Array>;
export const VARIANTS: string[];
export function buildVariant(
  variant: string,
  opts?: { seed?: number; biblatex?: boolean },
): Map<string, string | Uint8Array>;
