import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "resolve_row") {
      const { row_id, resolution_action, matched_product_id } = body;
      
      const { error } = await supabase
        .from("import_rows")
        .update({
          resolution_action,
          matched_product_id: matched_product_id || null,
          match_status: resolution_action === "skip" ? "skipped" : 
                       resolution_action === "manual_link" ? "matched" :
                       resolution_action === "create" ? "new" : "matched",
          resolved_at: new Date().toISOString(),
        })
        .eq("id", row_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      }

      // Recalculate job counts
      const { data: rowData } = await supabase
        .from("import_rows")
        .select("import_job_id")
        .eq("id", row_id)
        .single();

      if (rowData) {
        await recalculateJobCounts(supabase, rowData.import_job_id);
      }

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});

async function recalculateJobCounts(supabase: any, jobId: string) {
  const statuses = ["matched", "new", "ambiguous", "invalid", "skipped"];
  const counts: Record<string, number> = {};

  for (const s of statuses) {
    const { count } = await supabase
      .from("import_rows")
      .select("id", { count: "exact", head: true })
      .eq("import_job_id", jobId)
      .eq("match_status", s);
    counts[s] = count || 0;
  }

  const { count: total } = await supabase
    .from("import_rows")
    .select("id", { count: "exact", head: true })
    .eq("import_job_id", jobId);

  await supabase.from("import_jobs").update({
    total_rows: total || 0,
    matched_rows: counts.matched || 0,
    new_rows: counts.new || 0,
    ambiguous_rows: counts.ambiguous || 0,
    invalid_rows: counts.invalid || 0,
    skipped_rows: counts.skipped || 0,
  }).eq("id", jobId);
}
