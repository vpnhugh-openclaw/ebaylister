/**
 * Parser for "Canonical Mega Master" product spreadsheets.
 *
 * Expected columns (case-insensitive, accepts CSV or XLSX):
 *   Barcode, Product Name, Vendor, Category, Tags, Description_HTML,
 *   Description_Plain, PDE, Sell Price, RRP, Weight, Variant_Taxable,
 *   Variant_RequiresShipping, Option1_Value, Option2_Name, Option2_Value,
 *   Image_1..Image_5, All_Images_Count, All_Image_URLs, Published,
 *   Created_At, Updated_At, Variants_Count, Product_URL
 */
import * as XLSX from "xlsx";

export interface CanonicalMasterRow {
  row_number: number;
  raw_data: Record<string, unknown>;
  // Mapped to products table columns
  barcode: string | null;
  source_product_name: string | null;
  normalized_product_name: string | null;
  brand: string | null;
  product_type: string | null;
  tags: string[] | null;
  full_description_html: string | null;
  short_description: string | null;
  supplier_product_code: string | null; // PDE
  sell_price: number | null;
  shopify_listed_price: number | null; // RRP (reference recommended retail)
  weight_grams: number | null;
  variant: string | null;
  pack_size: string | null;
  source_links: { product_url: string | null } | null;
  // Side-channel: images for separate upsert
  image_urls: string[];
  validation_errors: Array<{ field: string; message: string }>;
}

export interface CanonicalMasterParseResult {
  rows: CanonicalMasterRow[];
  detectedHeaders: string[];
  mappedHeaders: Record<string, string>;
  unmappedHeaders: string[];
  warnings: string[];
  totalRawRows: number;
}

const HEADER_ALIASES: Record<string, string> = {
  barcode: "barcode",
  gtin: "barcode",
  ean: "barcode",
  upc: "barcode",
  product_name: "product_name",
  "product name": "product_name",
  name: "product_name",
  title: "product_name",
  vendor: "vendor",
  brand: "vendor",
  category: "category",
  product_type: "category",
  "product type": "category",
  tags: "tags",
  description_html: "description_html",
  "description html": "description_html",
  body_html: "description_html",
  description_plain: "description_plain",
  "description plain": "description_plain",
  description: "description_plain",
  pde: "pde",
  supplier_product_code: "pde",
  "sell price": "sell_price",
  sell_price: "sell_price",
  price: "sell_price",
  rrp: "rrp",
  compare_at_price: "rrp",
  "compare at price": "rrp",
  weight: "weight",
  weight_g: "weight",
  weight_grams: "weight",
  option1_value: "option1_value",
  "option1 value": "option1_value",
  option2_value: "option2_value",
  "option2 value": "option2_value",
  image_1: "image_1",
  "image 1": "image_1",
  image_2: "image_2",
  "image 2": "image_2",
  image_3: "image_3",
  "image 3": "image_3",
  image_4: "image_4",
  "image 4": "image_4",
  image_5: "image_5",
  "image 5": "image_5",
  all_image_urls: "all_image_urls",
  "all image urls": "all_image_urls",
  product_url: "product_url",
  "product url": "product_url",
};

function normalizeHeader(h: string): string {
  return String(h ?? "").trim().toLowerCase().replace(/[_\-\s]+/g, "_");
}

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function cleanBarcode(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/^["']+|["']+$/g, "");
  if (s === "") return null;
  // Numeric value coming back from XLSX may be like 9890108145945 or "9.89e+12"
  if (/^\d+\.\d+e\+\d+$/i.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n) && Number.isFinite(n)) s = n.toFixed(0);
  }
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
}

function safeDecimal(
  v: unknown,
  field: string,
  errors: Array<{ field: string; message: string }>,
): number | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === "") return null;
  s = s.replace(/^[$€£¥]+/, "").replace(/,/g, "").trim();
  const n = Number(s);
  if (Number.isNaN(n)) {
    errors.push({ field, message: `Invalid number: "${v}"` });
    return null;
  }
  return Math.round(n * 100) / 100;
}

function safeInt(v: unknown, field: string, errors: Array<{ field: string; message: string }>): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  if (Number.isNaN(n)) {
    errors.push({ field, message: `Invalid integer: "${v}"` });
    return null;
  }
  return Math.round(n);
}

function parseTags(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "") return null;
  return s
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function collectImages(raw: Record<string, unknown>, headerMap: Record<string, string>): string[] {
  const out: string[] = [];
  const get = (canonical: string): string | null => {
    for (const [rawH, mapped] of Object.entries(headerMap)) {
      if (mapped === canonical) return trimOrNull(raw[rawH]);
    }
    return null;
  };
  for (const k of ["image_1", "image_2", "image_3", "image_4", "image_5"]) {
    const u = get(k);
    if (u) out.push(u);
  }
  const all = get("all_image_urls");
  if (all) {
    for (const u of all.split(/[;\n]/)) {
      const cleaned = u.trim();
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
  }
  return out;
}

export async function parseCanonicalMasterFile(
  file: File,
): Promise<CanonicalMasterParseResult> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", raw: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: null,
    raw: false,
  });

  const warnings: string[] = [];
  const rawHeaders = rows.length > 0 ? Object.keys(rows[0]) : [];

  const headerMap: Record<string, string> = {};
  const unmapped: string[] = [];
  for (const h of rawHeaders) {
    const norm = normalizeHeader(h);
    const canonical = HEADER_ALIASES[norm];
    if (canonical) headerMap[h] = canonical;
    else unmapped.push(h);
  }
  if (unmapped.length > 0) {
    warnings.push(`Unmapped columns ignored: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? "…" : ""}`);
  }

  const get = (raw: Record<string, unknown>, canonical: string): unknown => {
    for (const [rawH, mapped] of Object.entries(headerMap)) {
      if (mapped === canonical) return raw[rawH];
    }
    return null;
  };

  const out: CanonicalMasterRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const errors: Array<{ field: string; message: string }> = [];

    const name = trimOrNull(get(raw, "product_name"));
    if (!name) {
      errors.push({ field: "product_name", message: "Missing product name" });
    }

    const variantVal = trimOrNull(get(raw, "option1_value"));
    const isDefault = variantVal && /^default\s*title$/i.test(variantVal);

    const row: CanonicalMasterRow = {
      row_number: i + 2, // header is row 1
      raw_data: raw,
      barcode: cleanBarcode(get(raw, "barcode")),
      source_product_name: name,
      normalized_product_name: name ? name.toLowerCase().trim() : null,
      brand: trimOrNull(get(raw, "vendor")),
      product_type: trimOrNull(get(raw, "category")),
      tags: parseTags(get(raw, "tags")),
      full_description_html: trimOrNull(get(raw, "description_html")),
      short_description: trimOrNull(get(raw, "description_plain")),
      supplier_product_code: trimOrNull(get(raw, "pde")),
      sell_price: safeDecimal(get(raw, "sell_price"), "sell_price", errors),
      shopify_listed_price: safeDecimal(get(raw, "rrp"), "rrp", errors),
      weight_grams: safeInt(get(raw, "weight"), "weight", errors),
      variant: isDefault ? null : variantVal,
      pack_size: trimOrNull(get(raw, "option2_value")),
      source_links: (() => {
        const url = trimOrNull(get(raw, "product_url"));
        return url ? { product_url: url } : null;
      })(),
      image_urls: collectImages(raw, headerMap),
      validation_errors: errors,
    };
    out.push(row);
  }

  return {
    rows: out,
    detectedHeaders: rawHeaders,
    mappedHeaders: headerMap,
    unmappedHeaders: unmapped,
    warnings,
    totalRawRows: rows.length,
  };
}

/**
 * Convert a parsed row into the products-table payload understood by
 * the existing `bulk-product-upsert` edge function.
 */
export function canonicalRowToProductData(row: CanonicalMasterRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    barcode: row.barcode,
    source_product_name: row.source_product_name,
    normalized_product_name: row.normalized_product_name,
    brand: row.brand,
    product_type: row.product_type,
    tags: row.tags,
    full_description_html: row.full_description_html,
    short_description: row.short_description,
    supplier_product_code: row.supplier_product_code,
    sell_price: row.sell_price,
    shopify_listed_price: row.shopify_listed_price,
    weight_grams: row.weight_grams,
    variant: row.variant,
    pack_size: row.pack_size,
    product_status: "active",
    compliance_status: "pending",
  };
  // Strip nulls so fill_blanks mode behaves correctly
  for (const k of Object.keys(payload)) {
    if (payload[k] === null || payload[k] === undefined) delete payload[k];
  }
  return payload;
}
