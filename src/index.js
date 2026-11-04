/**
 * Medix Backend - Serverless Drug-Drug Interaction Detection API
 * Engine: Cloudflare Workers + Supabase (PostgreSQL with GIN Trigram Search)
 * Author: Shivam Raj
 * License: MIT
 */

const DEFAULT_SUPABASE_URL = "https://xcpyxdphxjjtobiutpbr.supabase.co";

// In-memory LRU caches
const interactionCache = new Map();
const MAX_CACHE_SIZE = 500;

const searchCache = new Map();
const MAX_SEARCH_CACHE_SIZE = 1000;

export default {
  /**
   * Main HTTP Request Handler
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // 1. Handle HTTP OPTIONS (CORS Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const supabaseKey = env.SUPABASE_KEY;

    if (!supabaseKey) {
      return new Response(
        JSON.stringify({
          error: "Server configuration error: SUPABASE_KEY is missing.",
          message: "Please configure SUPABASE_KEY in Cloudflare Worker secrets or .dev.vars",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabaseHeaders = {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    };

    // 2. Health Check / Root Endpoint (GET / or GET /health)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify(
          {
            service: "Medix Drug-Drug Interaction API",
            status: "online",
            version: "2.0.0",
            architecture: "Cloudflare Workers + Supabase PostgreSQL (Trigram Search)",
            timestamp: new Date().toISOString(),
            endpoints: {
              health: "GET /health",
              search: "GET /api/search?q={query}&detailed={true|false}",
              interactions: "POST /api/interactions",
            },
            documentation: "https://github.com/bettercallshiv/medix-backend",
          },
          null,
          2
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    // 3. Autocomplete / Medicine Search (GET /api/search?q=...&detailed=true)
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q");
      const detailed = url.searchParams.get("detailed") === "true";
      if (!query || query.trim().length < 2) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        });
      }

      try {
        const cleanQuery = query.trim();
        const cacheKey = `${cleanQuery.toLowerCase()}_${detailed}`;

        if (searchCache.has(cacheKey)) {
          return new Response(searchCache.get(cacheKey), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cache": "HIT",
              "Cache-Control": "public, max-age=86400, s-maxage=86400",
              ...corsHeaders,
            },
          });
        }

        // Search both brand_name and composition using Supabase GIN Trigram index
        const encodedQuery = encodeURIComponent(`*${cleanQuery}*`);
        const supaUrl = `${supabaseUrl}/rest/v1/medicines?or=(brand_name.ilike.${encodedQuery},composition.ilike.${encodedQuery})&select=brand_name,composition&limit=25`;

        const resp = await fetch(supaUrl, { headers: supabaseHeaders });
        if (!resp.ok) {
          throw new Error(`Supabase query failed with status: ${resp.status}`);
        }

        const data = await resp.json();
        const finalResults = Array.isArray(data) ? data : [];
        const output = detailed
          ? finalResults.map((r) => ({
              brand_name: r.brand_name,
              composition: r.composition || "",
            }))
          : finalResults.map((r) => r.brand_name);

        const responsePayload = JSON.stringify(output);
        if (searchCache.size >= MAX_SEARCH_CACHE_SIZE) {
          const oldestKey = searchCache.keys().next().value;
          searchCache.delete(oldestKey);
        }
        searchCache.set(cacheKey, responsePayload);

        return new Response(responsePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            "Cache-Control": "public, max-age=86400, s-maxage=86400",
            ...corsHeaders,
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: "Search query failed", details: error.message }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          }
        );
      }
    }

    // 4. Drug-Drug Interaction Engine (POST /api/interactions)
    if (request.method === "POST" && url.pathname === "/api/interactions") {
      try {
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify({ error: "Invalid JSON payload" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        const medications = body.medications;
        if (!Array.isArray(medications) || medications.length === 0) {
          return new Response(
            JSON.stringify({
              error: "Missing or invalid 'medications' array in request body",
              example: { medications: ["Dolo 650", "Augmentin"] },
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        const sanitizedMeds = medications
          .map((m) => (typeof m === "string" ? m.trim() : ""))
          .filter((m) => m.length > 0);

        if (sanitizedMeds.length === 0) {
          return new Response(
            JSON.stringify({ error: "No valid medication names provided" }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }

        const lookupTerms = new Set();
        sanitizedMeds.forEach((med) => {
          lookupTerms.add(med);
          const cleaned = med
            .replace(/\b(\d+(\.\d+)?\s*(mg|mcg|g|ml|iu)|tablet|capsule|syrup|injection|suspension|drops|sr|er|mr|cr|ds)\b/gi, "")
            .trim();
          if (cleaned && cleaned.length >= 2) {
            lookupTerms.add(cleaned);
          }
        });

        const termsArray = Array.from(lookupTerms);
        const cacheKey = termsArray.slice().sort().join("|").toLowerCase();
        if (interactionCache.has(cacheKey)) {
          return new Response(interactionCache.get(cacheKey), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cache": "HIT",
              ...corsHeaders,
            },
          });
        }

        // ==============================================================
        // QUERY STEP 1: Map Brand Names to Active Ingredients (Compositions)
        // ==============================================================
        const compositionsMap = {};
        const uniqueIngredients = new Set();
        const foundBrands = new Set();

        // Exact match lookups on Supabase
        const quotedTerms = termsArray.map((t) => `"${t.replace(/"/g, "")}"`).join(",");
        const medQueryUrl = `${supabaseUrl}/rest/v1/medicines?brand_name=in.(${encodeURIComponent(quotedTerms)})&select=brand_name,composition`;
        const medResp = await fetch(medQueryUrl, { headers: supabaseHeaders });

        if (medResp.ok) {
          const medData = await medResp.json();
          if (Array.isArray(medData)) {
            medData.forEach((row) => {
              compositionsMap[row.brand_name] = row.composition;
              foundBrands.add(row.brand_name.toLowerCase());
              row.composition.split(",").map((i) => i.trim()).forEach((i) => {
                if (i) uniqueIngredients.add(i);
              });
            });
          }
        }

        // Fallback prefix search for terms not found via exact match
        for (const term of termsArray) {
          const lowerTerm = term.toLowerCase();
          if (!foundBrands.has(lowerTerm)) {
            const prefixUrl = `${supabaseUrl}/rest/v1/medicines?or=(brand_name.ilike.${encodeURIComponent(term + "*")},composition.ilike.${encodeURIComponent(term + "*")})&select=brand_name,composition&limit=1`;
            const prefixResp = await fetch(prefixUrl, { headers: supabaseHeaders });
            if (prefixResp.ok) {
              const prefixData = await prefixResp.json();
              if (Array.isArray(prefixData) && prefixData.length > 0) {
                const matched = prefixData[0];
                compositionsMap[term] = matched.composition;
                compositionsMap[matched.brand_name] = matched.composition;
                matched.composition.split(",").map((i) => i.trim()).forEach((i) => {
                  if (i) uniqueIngredients.add(i);
                });
                foundBrands.add(lowerTerm);
              }
            }
          } else {
            for (const key of Object.keys(compositionsMap)) {
              if (key.toLowerCase() === lowerTerm) {
                compositionsMap[term] = compositionsMap[key];
                break;
              }
            }
          }
        }

        // Ensure sanitizedMeds have composition mapped
        sanitizedMeds.forEach((med) => {
          if (!compositionsMap[med]) {
            const cleaned = med
              .replace(/\b(\d+(\.\d+)?\s*(mg|mcg|g|ml|iu)|tablet|capsule|syrup|injection|suspension|drops|sr|er|mr|cr|ds)\b/gi, "")
              .trim();
            if (compositionsMap[cleaned]) {
              compositionsMap[med] = compositionsMap[cleaned];
            } else {
              const foundKey = Object.keys(compositionsMap).find(
                (k) => k.toLowerCase() === med.toLowerCase() || k.toLowerCase() === cleaned.toLowerCase()
              );
              if (foundKey) {
                compositionsMap[med] = compositionsMap[foundKey];
              }
            }
          }
        });

        // Add raw term names if 3+ chars as possible ingredients
        termsArray.forEach((term) => {
          if (term.length >= 3) {
            uniqueIngredients.add(term);
          }
        });

        // Common Synonyms
        const synonyms = {
          "paracetamol": "Acetaminophen",
          "acetaminophen": "Paracetamol",
          "aspirin": "Acetylsalicylic Acid",
          "acetylsalicylic acid": "Aspirin",
          "vitamin d3": "Cholecalciferol",
          "cholecalciferol": "Vitamin D3",
          "lipitor": "Atorvastatin",
          "glucophage": "Metformin",
          "tylenol": "Acetaminophen",
          "advil": "Ibuprofen",
          "motrin": "Ibuprofen",
        };
        Array.from(uniqueIngredients).forEach((ing) => {
          const lower = ing.toLowerCase();
          if (synonyms[lower]) {
            uniqueIngredients.add(synonyms[lower]);
          }
        });

        const ingredientsArray = Array.from(uniqueIngredients);

        // ==============================================================
        // QUERY STEP 2: Evaluate Combinatorial Interactions by Medicine
        // ==============================================================
        // Identify canonical screened medications (prefer longer brand names over stripped base names)
        const uniqueInputMeds = Array.from(new Set(sanitizedMeds));
        const canonicalMeds = uniqueInputMeds.filter((med) => {
          const isCleanedVersionOfOther = uniqueInputMeds.some((other) => {
            if (other === med || other.length <= med.length) return false;
            const cleanOther = other
              .replace(/\b(\d+(\.\d+)?\s*(mg|mcg|g|ml|iu)|tablet|capsule|syrup|injection|suspension|drops|sr|er|mr|cr|ds)\b/gi, "")
              .trim().toLowerCase();
            return cleanOther === med.toLowerCase() || other.toLowerCase().includes(med.toLowerCase());
          });
          return !isCleanedVersionOfOther;
        });
        const finalScreenedMeds = canonicalMeds.length > 0 ? canonicalMeds : uniqueInputMeds;

        // Map each canonical medicine to its set of active ingredients (including synonyms)
        const medIngredientsMap = new Map();
        for (const med of finalScreenedMeds) {
          const comp = compositionsMap[med] || "";
          const ingSet = new Set();
          if (comp) {
            comp.split(",").forEach((c) => {
              const clean = c.trim().toLowerCase();
              if (clean) {
                ingSet.add(clean);
                if (synonyms[clean]) ingSet.add(synonyms[clean].toLowerCase());
              }
            });
          }
          const cleanMed = med
            .replace(/\b(\d+(\.\d+)?\s*(mg|mcg|g|ml|iu)|tablet|capsule|syrup|injection|suspension|drops|sr|er|mr|cr|ds)\b/gi, "")
            .trim().toLowerCase();
          if (cleanMed.length >= 2) {
            ingSet.add(cleanMed);
            if (synonyms[cleanMed]) ingSet.add(synonyms[cleanMed].toLowerCase());
          }
          medIngredientsMap.set(med, ingSet);
        }

        let rawInteractions = [];
        if (ingredientsArray.length > 1) {
          const quotedIngs = ingredientsArray.map((i) => `"${i.replace(/"/g, "")}"`).join(",");
          const intUrl = `${supabaseUrl}/rest/v1/interactions?drug1=in.(${encodeURIComponent(quotedIngs)})&drug2=in.(${encodeURIComponent(quotedIngs)})&select=drug1,drug2,severity,description`;
          const intResp = await fetch(intUrl, { headers: supabaseHeaders });
          if (intResp.ok) {
            const intData = await intResp.json();
            if (Array.isArray(intData)) {
              rawInteractions = intData;
            }
          }
        }

        // Deduplicate and group by distinct MEDICINES
        // 1. Never show a medicine interacting with itself (self-interactions inside combination drugs)
        // 2. Only show A + B once (never both A + B and B + A)
        // 3. Show interactions by medicines, with active compositions detailed
        const pairsMap = new Map();

        for (const raw of rawInteractions) {
          const d1 = (raw.drug1 || "").trim().toLowerCase();
          const d2 = (raw.drug2 || "").trim().toLowerCase();
          if (!d1 || !d2) continue;

          const meds1 = finalScreenedMeds.filter((m) => {
            const set = medIngredientsMap.get(m);
            return set && (set.has(d1) || Array.from(set).some((ing) => ing.includes(d1) || d1.includes(ing)));
          });

          const meds2 = finalScreenedMeds.filter((m) => {
            const set = medIngredientsMap.get(m);
            return set && (set.has(d2) || Array.from(set).some((ing) => ing.includes(d2) || d2.includes(ing)));
          });

          for (const m1 of meds1) {
            for (const m2 of meds2) {
              // Rule 1: A medicine NEVER interacts with itself
              if (m1.toLowerCase() === m2.toLowerCase()) {
                continue;
              }

              // Rule 2: Bidirectional canonical ordering (A + B is same as B + A)
              const [firstMed, secondMed] = [m1, m2].sort((a, b) => a.localeCompare(b));
              const pairKey = `${firstMed.toLowerCase()}|||${secondMed.toLowerCase()}`;

              if (!pairsMap.has(pairKey)) {
                pairsMap.set(pairKey, {
                  drug1: firstMed,
                  drug2: secondMed,
                  severities: [],
                  descriptions: [],
                  matchedIngredients1: new Set(),
                  matchedIngredients2: new Set(),
                });
              }

              const entry = pairsMap.get(pairKey);
              entry.severities.push(raw.severity || "Moderate");
              if (raw.description && raw.description.trim()) {
                entry.descriptions.push(raw.description.trim());
              }
              if (m1 === firstMed) {
                entry.matchedIngredients1.add(raw.drug1);
                entry.matchedIngredients2.add(raw.drug2);
              } else {
                entry.matchedIngredients1.add(raw.drug2);
                entry.matchedIngredients2.add(raw.drug1);
              }
            }
          }
        }

        const deduplicatedInteractions = [];
        for (const [_, entry] of pairsMap.entries()) {
          const hasHigh = entry.severities.some(
            (s) => s.toLowerCase() === "high" || s.toLowerCase() === "major" || s.toLowerCase() === "severe"
          );
          const hasMod = entry.severities.some((s) => s.toLowerCase() === "moderate");
          const resolvedSeverity = hasHigh ? "High" : (hasMod ? "Moderate" : "Minor");

          const comp1 = compositionsMap[entry.drug1] || Array.from(entry.matchedIngredients1).join(", ");
          const comp2 = compositionsMap[entry.drug2] || Array.from(entry.matchedIngredients2).join(", ");

          const clinicalDesc = entry.descriptions.length > 0
            ? entry.descriptions[0]
            : `${resolvedSeverity} interaction between ${entry.drug1} and ${entry.drug2}.`;

          deduplicatedInteractions.push({
            drug1: entry.drug1,
            drug2: entry.drug2,
            severity: resolvedSeverity,
            ingredient1: comp1,
            ingredient2: comp2,
            description: clinicalDesc,
          });
        }

        const responsePayload = JSON.stringify({
          compositions: compositionsMap,
          interactions: deduplicatedInteractions,
          meta: {
            analyzedMedicationsCount: finalScreenedMeds.length,
            identifiedIngredientsCount: ingredientsArray.length,
            interactionsFoundCount: deduplicatedInteractions.length,
          },
        });

        if (interactionCache.size >= MAX_CACHE_SIZE) {
          const firstKey = interactionCache.keys().next().value;
          interactionCache.delete(firstKey);
        }
        interactionCache.set(cacheKey, responsePayload);

        return new Response(responsePayload, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "MISS",
            ...corsHeaders,
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "Failed to process interaction check",
            details: error.message,
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          }
        );
      }
    }

    return new Response(
      JSON.stringify({
        error: "Route not found",
        path: url.pathname,
        availableEndpoints: ["GET /health", "GET /api/search?q={query}", "POST /api/interactions"],
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  },
};
