/**
 * Parser for Evelyn Faye supplier CSV format.
 * Columns: title, variant_title, brand, product_type, tags, sku, barcode,
 *          price, compare_at_price, weight_g, weight_unit, option1, option2, option3,
 *          image, description
 */
import Papa from "papaparse";

export interface EvelynFayeParsedRow {
  row_number: number;
  raw_data: Record<string, string>;
  // Mapped fields (ready for products table)
  source_product_name: string | null;
  variant: string | null;
  brand: string | null;
  product_type: string | null;
  tags: string[] | null;
  sku: string | null;
  barcode: string | null;
  sell_price: number | null;
  cost_price: number | null; // compare_at_price mapped here as reference
  weight_grams: number | null;
  unit_of_measure: string | null;
  size_value: string | null; // option1
  flavour: string | null; // option2
  pack_size: string | null; // option3
  primary_image_url: string | null;
  full_description_html: string | null;
  validation_errors: Array<{ field: string; message: string }>;
}

export interface EvelynFayeParseResult {
  rows: EvelynFayeParsedRow[];
  detectedHeaders: string[];
  mappedHeaders: Record<string, string>;
  unmappedHeaders: string[];
  warnings: string[];
}

// Header aliases → canonical CSV column name
const HEADER_ALIASES: Record<string, string> = {
  title: "title",
  name: "title",
  product_name: "title",
  "product name": "title",
  variant_title: "variant_title",
  "variant title": "variant_title",
  variant_name: "variant_title",
  "variant name": "variant_title",
  brand: "brand",
  product_type: "product_type",
  "product type": "product_type",
  category: "product_type",
  tags: "tags",
  sku: "sku",
  barcode: "barcode",
  gtin: "barcode",
  ean: "barcode",
  upc: "barcode",
  price: "price",
  retail_price: "price",
  "retail price": "price",
  compare_at_price: "compare_at_price",
  "compare at price": "compare_at_price",
  rrp: "compare_at_price",
  original_price: "compare_at_price",
  "original price": "compare_at_price",
  weight_g: "weight_g",
  "weight g": "weight_g",
  weight_value: "weight_g",
  shipping_weight: "weight_g",
  weight: "weight_g",
  weight_unit: "weight_unit",
  "weight unit": "weight_unit",
  option1: "option1",
  "option 1": "option1",
  option2: "option2",
  "option 2": "option2",
  option3: "option3",
  "option 3": "option3",
  image: "image",
  image_url: "image",
  image_src: "image",
  "image url": "image",
  "image src": "image",
  primary_image: "image",
  description: "description",
  body_html: "description",
  product_description: "description",
  "product description": "description",
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_\-]+/g, "_");
}

function trimOrNull(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === "" ? null : s;
}

/**
 * Clean barcode string:
 * - treat as string end-to-end
 * - trim whitespace/quotes
 * - remove trailing .0 from float-like strings (e.g. "9340760000000.0" → "9340760000000")
 * - preserve leading zeros
 */
function cleanBarcode(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  let s = String(val).trim().replace(/^["']+|["']+$/g, "");
  if (s === "") return null;
  // Remove trailing .0 only when the rest is all digits
  if (/^\d+\.0$/.test(s)) {
    s = s.replace(/\.0$/, "");
  }
  return s;
}

function safeDecimal(val: unknown, field: string, errors: Array<{ field: string; message: string }>): number | null {
  if (val === null || val === undefined) return null;
  let s = String(val).trim();
  if (s === "") return null;
  // Remove currency symbols
  s = s.replace(/^[$€£¥]+/, "").trim();
  // Remove commas
  s = s.replace(/,/g, "");
  const n = Number(s);
  if (isNaN(n)) {
    errors.push({ field, message: `Invalid number: "${val}"` });
    return null;
  }
  return Math.round(n * 100) / 100;
}

function safeWeight(val: unknown, field: string, errors: Array<{ field: string; message: string }>): number | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "") return null;
  const n = Number(s);
  if (isNaN(n)) {
    errors.push({ field, message: `Invalid weight: "${val}"` });
    return null;
  }
  return Math.round(n);
}

function parseTags(val: unknown): string[] | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (s === "") return null;
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

export function parseEvelynFayeCSV(file: File): Promise<EvelynFayeParseResult> {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rawHeaders = results.meta.fields || [];
        const warnings: string[] = [];

        // Build header mapping
        const headerMap: Record<string, string> = {};
        const unmapped: string[] = [];
        for (const h of rawHeaders) {
          const norm = normalizeHeader(h);
          const canonical = HEADER_ALIASES[norm] || HEADER_ALIASES[h.trim().toLowerCase()];
          if (canonical) {
            headerMap[h] = canonical;
          } else {
            unmapped.push(h);
          }
        }

        if (unmapped.length > 0) {
          warnings.push(`Unmapped columns: ${unmapped.join(", ")}`);
        }

        // Check for required columns
        const mappedCanonical = new Set(Object.values(headerMap));
        if (!mappedCanonical.has("title")) {
          warnings.push("No 'title' column detected — products may import without names");
        }

        // Parse rows
        const data = results.data as Record<string, string>[];
        const rows: EvelynFayeParsedRow[] = [];

        for (let i = 0; i < data.length; i++) {
          const raw = data[i];
          const errors: Array<{ field: string; message: string }> = [];

          // Resolve each canonical field from raw using headerMap
          const get = (canonical: string): string | null => {
            for (const [rawH, mapped] of Object.entries(headerMap)) {
              if (mapped === canonical) {
                return trimOrNull(raw[rawH]);
              }
            }
            return null;
          };

          const title = get("title");
          if (!title) {
            errors.push({ field: "title", message: "Missing product title" });
          }

          const priceVal = get("price");
          const compareVal = get("compare_at_price");

          const row: EvelynFayeParsedRow = {
            row_number: i + 1,
            raw_data: raw,
            source_product_name: title,
            variant: get("variant_title"),
            brand: get("brand"),
            product_type: get("product_type"),
            tags: parseTags(get("tags")),
            sku: trimOrNull(get("sku")),
            barcode: cleanBarcode(get("barcode")),
            sell_price: safeDecimal(priceVal, "price", errors),
            cost_price: safeDecimal(compareVal, "compare_at_price", errors),
            weight_grams: safeWeight(get("weight_g"), "weight_g", errors),
            unit_of_measure: get("weight_unit"),
            size_value: get("option1"),
            flavour: get("option2"),
            pack_size: get("option3"),
            primary_image_url: get("image"),
            full_description_html: get("description"),
            validation_errors: errors,
          };

          rows.push(row);
        }

        resolve({
          rows,
          detectedHeaders: rawHeaders,
          mappedHeaders: headerMap,
          unmappedHeaders: unmapped,
          warnings,
        });
      },
      error: () => {
        resolve({
          rows: [],
          detectedHeaders: [],
          mappedHeaders: {},
          unmappedHeaders: [],
          warnings: ["Failed to parse CSV file"],
        });
      },
    });
  });
}

/**
 * Convert a parsed Evelyn Faye row to the products table shape for upsert.
 */
export function evelynFayeRowToProductData(row: EvelynFayeParsedRow): Record<string, unknown> {
  return {
    source_product_name: row.source_product_name,
    normalized_product_name: row.source_product_name?.toLowerCase().trim() || null,
    variant: row.variant,
    brand: row.brand,
    product_type: row.product_type,
    tags: row.tags,
    sku: row.sku,
    barcode: row.barcode,
    sell_price: row.sell_price,
    cost_price: row.cost_price,
    weight_grams: row.weight_grams,
    unit_of_measure: row.unit_of_measure,
    size_value: row.size_value,
    flavour: row.flavour,
    pack_size: row.pack_size,
    full_description_html: row.full_description_html,
    product_status: "active",
    compliance_status: "pending",
  };
}
