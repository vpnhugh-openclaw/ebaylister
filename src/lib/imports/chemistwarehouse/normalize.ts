/**
 * Normalization utilities for Chemist Warehouse import data.
 * Designed to be reusable for other supplier imports.
 */

export function normalizeText(input: string): string {
  if (!input) return "";

  let text = input.trim();

  // Normalize unicode quotes to plain
  text = text.replace(/[\u2018\u2019]/g, "'");
  text = text.replace(/[\u201C\u201D]/g, '"');

  // Normalize en-dash/em-dash to hyphen
  text = text.replace(/[\u2013\u2014]/g, "-");

  // Remove zero-width characters
  text = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");

  // Collapse repeated whitespace
  text = text.replace(/\s+/g, " ");

  // Lowercase
  text = text.toLowerCase();

  return text.trim();
}

export function normalizeName(input: string): string {
  if (!input) return "";
  let text = normalizeText(input);

  // Remove trailing punctuation that doesn't affect product identity
  text = text.replace(/[.,;:!?]+$/, "");

  return text;
}

export function normalizeBrand(input: string): string {
  if (!input) return "";
  let text = normalizeText(input);

  // Remove common suffixes
  text = text.replace(/\s*(pty\.?\s*ltd\.?|inc\.?|corp\.?|limited|australia)$/i, "");

  return text.trim();
}

export function normalizeSlug(input: string): string {
  if (!input) return "";
  let text = normalizeText(input);

  // Replace non-alphanumeric with hyphens
  text = text.replace(/[^a-z0-9]+/g, "-");

  // Remove leading/trailing hyphens
  text = text.replace(/^-+|-+$/g, "");

  return text;
}
