/**
 * Matching logic for Chemist Warehouse import rows against existing products/sources.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedRow } from "./parser";

export interface CandidateMatch {
  product_id: string;
  name: string;
  score: number;
  method: string;
}

export interface MatchResult {
  match_status: "matched" | "new" | "ambiguous" | "invalid" | "skipped";
  match_method: string | null;
  match_confidence: number | null;
  matched_product_id: string | null;
  candidate_matches: CandidateMatch[];
}

export async function matchImportRow(
  row: ParsedRow,
  supabase: SupabaseClient
): Promise<MatchResult> {
  // Invalid if missing name
  if (!row.source_name_raw && !row.source_url && !row.source_sku) {
    return {
      match_status: "invalid",
      match_method: null,
      match_confidence: null,
      matched_product_id: null,
      candidate_matches: [],
    };
  }

  const candidates: CandidateMatch[] = [];

  // 1. Exact source_url match against product_sources
  if (row.source_url) {
    const { data } = await supabase
      .from("product_sources")
      .select("product_id, source_name_raw")
      .eq("source_name", "chemistwarehouse")
      .eq("source_url", row.source_url)
      .limit(1);

    if (data && data.length > 0) {
      return {
        match_status: "matched",
        match_method: "source_url",
        match_confidence: 1.0,
        matched_product_id: data[0].product_id,
        candidate_matches: [{ product_id: data[0].product_id, name: data[0].source_name_raw || "", score: 1.0, method: "source_url" }],
      };
    }
  }

  // 2. Exact source_sku match
  if (row.source_sku) {
    const { data } = await supabase
      .from("product_sources")
      .select("product_id, source_name_raw")
      .eq("source_name", "chemistwarehouse")
      .eq("source_sku", row.source_sku)
      .limit(1);

    if (data && data.length > 0) {
      return {
        match_status: "matched",
        match_method: "source_sku",
        match_confidence: 1.0,
        matched_product_id: data[0].product_id,
        candidate_matches: [{ product_id: data[0].product_id, name: data[0].source_name_raw || "", score: 1.0, method: "source_sku" }],
      };
    }
  }

  // 3. Exact source_product_id match
  if (row.source_product_id) {
    const { data } = await supabase
      .from("product_sources")
      .select("product_id, source_name_raw")
      .eq("source_name", "chemistwarehouse")
      .eq("source_product_id", row.source_product_id)
      .limit(1);

    if (data && data.length > 0) {
      return {
        match_status: "matched",
        match_method: "source_product_id",
        match_confidence: 1.0,
        matched_product_id: data[0].product_id,
        candidate_matches: [{ product_id: data[0].product_id, name: data[0].source_name_raw || "", score: 1.0, method: "source_product_id" }],
      };
    }
  }

  // 4. Exact normalized_name match against products.normalized_product_name
  if (row.normalized_name) {
    const { data } = await supabase
      .from("products")
      .select("id, source_product_name, brand")
      .eq("normalized_product_name", row.normalized_name)
      .limit(5);

    if (data && data.length === 1) {
      return {
        match_status: "matched",
        match_method: "normalized_name",
        match_confidence: 0.95,
        matched_product_id: data[0].id,
        candidate_matches: [{ product_id: data[0].id, name: data[0].source_product_name || "", score: 0.95, method: "normalized_name" }],
      };
    }

    if (data && data.length > 1) {
      for (const p of data) {
        candidates.push({
          product_id: p.id,
          name: p.source_product_name || "",
          score: 0.8,
          method: "normalized_name_multi",
        });
      }
    }
  }

  // 5. Fuzzy match using source_product_name ilike
  if (row.normalized_name && candidates.length === 0) {
    const searchTerm = `%${row.normalized_name.substring(0, 50)}%`;
    const { data } = await supabase
      .from("products")
      .select("id, source_product_name, brand")
      .ilike("source_product_name", searchTerm)
      .limit(5);

    if (data) {
      for (const p of data) {
        const score = computeSimpleScore(row.normalized_name, (p.source_product_name || "").toLowerCase());
        candidates.push({
          product_id: p.id,
          name: p.source_product_name || "",
          score,
          method: "fuzzy_name",
        });
      }
    }
  }

  // Evaluate candidates
  if (candidates.length === 0) {
    return {
      match_status: "new",
      match_method: null,
      match_confidence: null,
      matched_product_id: null,
      candidate_matches: [],
    };
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length === 1 && candidates[0].score >= 0.85) {
    return {
      match_status: "matched",
      match_method: candidates[0].method,
      match_confidence: candidates[0].score,
      matched_product_id: candidates[0].product_id,
      candidate_matches: candidates,
    };
  }

  if (candidates[0].score >= 0.9 && (candidates.length < 2 || candidates[0].score - candidates[1].score > 0.15)) {
    return {
      match_status: "matched",
      match_method: candidates[0].method,
      match_confidence: candidates[0].score,
      matched_product_id: candidates[0].product_id,
      candidate_matches: candidates,
    };
  }

  return {
    match_status: "ambiguous",
    match_method: "multiple_candidates",
    match_confidence: candidates[0].score,
    matched_product_id: null,
    candidate_matches: candidates,
  };
}

function computeSimpleScore(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0;

  const wordsA = a.split(/\s+/);
  const wordsB = new Set(b.split(/\s+/));
  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches++;
  }
  return matches / Math.max(wordsA.length, wordsB.size);
}
