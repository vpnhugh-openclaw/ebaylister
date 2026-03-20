/**
 * CSV parser for Chemist Warehouse scraper output.
 * Tolerates malformed rows and records per-row validation errors.
 */
import Papa from "papaparse";
import { normalizeName, normalizeBrand, normalizeSlug } from "./normalize";

export interface ParsedRow {
  row_number: number;
  raw_data: Record<string, unknown>;
  source_url: string | null;
  source_product_id: string | null;
  source_sku: string | null;
  source_slug: string | null;
  source_name_raw: string | null;
  source_brand: string | null;
  source_current_price: number | null;
  source_rrp: number | null;
  source_currency: string | null;
  source_in_stock: boolean | null;
  source_category_path: string | null;
  source_image_url: string | null;
  source_review_rating: number | null;
  source_review_count: number | null;
  source_updated_at: string | null;
  source_meta_json: Record<string, unknown> | null;
  normalized_name: string | null;
  normalized_brand: string | null;
  normalized_slug: string | null;
  validation_errors: Array<{ field: string; message: string }>;
}

function parseNumeric(value: unknown, field: string, errors: Array<{ field: string; message: string }>): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (isNaN(num)) {
    errors.push({ field, message: `Invalid numeric value: "${value}"` });
    return null;
  }
  return num;
}

function parseInt_(value: unknown, field: string, errors: Array<{ field: string; message: string }>): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (isNaN(num) || !Number.isInteger(num)) {
    errors.push({ field, message: `Invalid integer value: "${value}"` });
    return null;
  }
  return num;
}

function parseBool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return null;
}

function parseTimestamp(value: unknown, field: string, errors: Array<{ field: string; message: string }>): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(String(value));
  if (isNaN(d.getTime())) {
    errors.push({ field, message: `Invalid timestamp: "${value}"` });
    return null;
  }
  return d.toISOString();
}

function parseJson(value: unknown, field: string, errors: Array<{ field: string; message: string }>): Record<string, unknown> | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = JSON.parse(String(value));
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    errors.push({ field, message: `Invalid JSON` });
    return null;
  }
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim();
}

export function parseChemistWarehouseCSV(file: File): Promise<ParsedRow[]> {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim().toLowerCase(),
      complete: (results) => {
        const rows: ParsedRow[] = [];
        const data = results.data as Record<string, unknown>[];

        for (let i = 0; i < data.length; i++) {
          const raw = data[i];
          const errors: Array<{ field: string; message: string }> = [];

          const nameRaw = str(raw.name);
          const brandRaw = str(raw.brand);
          const slugRaw = str(raw.slug);

          if (!nameRaw) {
            errors.push({ field: "name", message: "Missing product name" });
          }

          const row: ParsedRow = {
            row_number: i + 1,
            raw_data: raw,
            source_url: str(raw.url),
            source_product_id: str(raw.product_id),
            source_sku: str(raw.sku),
            source_slug: slugRaw,
            source_name_raw: nameRaw,
            source_brand: brandRaw,
            source_current_price: parseNumeric(raw.current_price, "current_price", errors),
            source_rrp: parseNumeric(raw.current_rrp, "current_rrp", errors),
            source_currency: str(raw.currency_code),
            source_in_stock: parseBool(raw.in_stock),
            source_category_path: str(raw.category_path),
            source_image_url: str(raw.image_url),
            source_review_rating: parseNumeric(raw.review_rating, "review_rating", errors),
            source_review_count: parseInt_(raw.review_count, "review_count", errors),
            source_updated_at: parseTimestamp(raw.updated_at, "updated_at", errors),
            source_meta_json: parseJson(raw.meta_json, "meta_json", errors),
            normalized_name: nameRaw ? normalizeName(nameRaw) : null,
            normalized_brand: brandRaw ? normalizeBrand(brandRaw) : null,
            normalized_slug: slugRaw ? normalizeSlug(slugRaw) : null,
            validation_errors: errors,
          };

          rows.push(row);
        }

        resolve(rows);
      },
      error: () => {
        resolve([]);
      },
    });
  });
}
