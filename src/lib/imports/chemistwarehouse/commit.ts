/**
 * Commit logic for Chemist Warehouse import jobs.
 * Processes resolved import rows and creates/updates products + product_sources.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CommitResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ row_id: string; row_number: number; error: string }>;
}

interface ImportRow {
  id: string;
  row_number: number;
  resolution_action: string | null;
  match_status: string;
  matched_product_id: string | null;
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
}

function buildSourceRecord(row: ImportRow) {
  return {
    source_name: "chemistwarehouse" as const,
    source_url: row.source_url,
    source_product_id: row.source_product_id,
    source_sku: row.source_sku,
    source_slug: row.source_slug,
    source_name_raw: row.source_name_raw,
    source_brand: row.source_brand,
    source_current_price: row.source_current_price,
    source_rrp: row.source_rrp,
    source_currency: row.source_currency,
    source_in_stock: row.source_in_stock,
    source_category_path: row.source_category_path,
    source_image_url: row.source_image_url,
    source_review_rating: row.source_review_rating,
    source_review_count: row.source_review_count,
    source_updated_at: row.source_updated_at,
    source_meta_json: row.source_meta_json,
    last_synced_at: new Date().toISOString(),
  };
}

export async function commitImportJob(
  jobId: string,
  supabase: SupabaseClient
): Promise<CommitResult> {
  const result: CommitResult = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

  // Update job status to importing
  await supabase
    .from("import_jobs")
    .update({ status: "importing" })
    .eq("id", jobId);

  // Load all rows for job
  const { data: rows, error: fetchError } = await supabase
    .from("import_rows")
    .select("*")
    .eq("import_job_id", jobId)
    .not("resolution_action", "is", null)
    .order("row_number");

  if (fetchError || !rows) {
    await supabase
      .from("import_jobs")
      .update({ status: "failed", error_summary: fetchError?.message || "Failed to load rows" })
      .eq("id", jobId);
    return result;
  }

  for (const row of rows as ImportRow[]) {
    try {
      if (row.resolution_action === "skip") {
        result.skipped++;
        continue;
      }

      if (row.resolution_action === "update" || row.resolution_action === "manual_link") {
        if (!row.matched_product_id) {
          result.errors.push({ row_id: row.id, row_number: row.row_number, error: "No matched product ID" });
          result.failed++;
          continue;
        }

        // Upsert product_sources
        const sourceData = { ...buildSourceRecord(row), product_id: row.matched_product_id };

        if (row.source_url) {
          // Try update by source_url first
          const { data: existing } = await supabase
            .from("product_sources")
            .select("id")
            .eq("source_name", "chemistwarehouse")
            .eq("source_url", row.source_url)
            .limit(1);

          if (existing && existing.length > 0) {
            await supabase.from("product_sources").update(sourceData).eq("id", existing[0].id);
          } else {
            await supabase.from("product_sources").insert(sourceData);
          }
        } else {
          await supabase.from("product_sources").insert(sourceData);
        }

        // Fill blank fields on the product (do not overwrite existing data)
        const { data: product } = await supabase
          .from("products")
          .select("source_product_name, brand, sell_price, cost_price")
          .eq("id", row.matched_product_id)
          .single();

        if (product) {
          const updates: Record<string, unknown> = {};
          if (!product.source_product_name && row.source_name_raw) updates.source_product_name = row.source_name_raw;
          if (!product.brand && row.source_brand) updates.brand = row.source_brand;
          if (!product.sell_price && row.source_current_price) updates.sell_price = row.source_current_price;

          if (Object.keys(updates).length > 0) {
            await supabase.from("products").update(updates).eq("id", row.matched_product_id);
          }
        }

        result.updated++;
      }

      if (row.resolution_action === "create") {
        // Insert new product
        const { data: newProduct, error: insertErr } = await supabase
          .from("products")
          .insert({
            source_product_name: row.source_name_raw,
            normalized_product_name: row.normalized_name,
            brand: row.source_brand,
            sell_price: row.source_current_price,
            cost_price: row.source_rrp ? row.source_rrp * 0.5 : null, // Rough estimate
            product_status: "active",
          })
          .select("id")
          .single();

        if (insertErr || !newProduct) {
          result.errors.push({ row_id: row.id, row_number: row.row_number, error: insertErr?.message || "Failed to create product" });
          result.failed++;
          continue;
        }

        // Insert product_source
        await supabase.from("product_sources").insert({
          ...buildSourceRecord(row),
          product_id: newProduct.id,
        });

        // Update import row with the new product id
        await supabase
          .from("import_rows")
          .update({ matched_product_id: newProduct.id })
          .eq("id", row.id);

        result.created++;
      }
    } catch (err) {
      result.errors.push({ row_id: row.id, row_number: row.row_number, error: String(err) });
      result.failed++;
    }
  }

  // Count skipped (no resolution_action)
  const { count: unresolved } = await supabase
    .from("import_rows")
    .select("id", { count: "exact", head: true })
    .eq("import_job_id", jobId)
    .is("resolution_action", null);

  result.skipped += unresolved || 0;

  // Update job final status
  await supabase
    .from("import_jobs")
    .update({
      status: result.failed > 0 ? "completed" : "completed",
      completed_at: new Date().toISOString(),
      matched_rows: result.updated,
      new_rows: result.created,
      skipped_rows: result.skipped,
      error_summary: result.errors.length > 0 ? `${result.errors.length} rows failed` : null,
    })
    .eq("id", jobId);

  return result;
}
