/**
 * Medix Backend - Serverless Drug-Drug Interaction Detection API
 *
 * Architecture:
 * - Powered by Cloudflare Workers (Edge Serverless Computing)
 * - Cloudflare D1 (Serverless Distributed SQLite Engine)
 * - Sub-50ms Global Latency
 *
 * Author: Shivam Raj
 * License: MIT
 */

export default {
  /**
   * Main HTTP Request Handler
   * @param {Request} request
   * @param {Record<string, any>} env - Environment bindings (e.g. env.DB)
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Standard CORS Headers for Cross-Origin Resource Sharing
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

    // 2. Health Check / Root Endpoint (GET / or GET /health)
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(
        JSON.stringify(
          {
            service: "Medix Drug-Drug Interaction API",
            status: "online",
            version: "1.0.0",
            architecture: "Cloudflare Workers + D1 Serverless SQL",
            timestamp: new Date().toISOString(),
            endpoints: {
              health: "GET /health",
              search: "GET /api/search?q={query}",
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

    // 3. Autocomplete / Medicine Search (GET /api/search?q=...)
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q");

      // Minimum query length of 2 characters to optimize DB load
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
        const { results } = await env.DB.prepare(
          `SELECT brand_name FROM medicines WHERE brand_name LIKE ? COLLATE NOCASE ORDER BY brand_name COLLATE NOCASE ASC LIMIT 10`
        )
          .bind(cleanQuery + "%")
          .all();

        const suggestions = results.map((r) => r.brand_name);
        return new Response(JSON.stringify(suggestions), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400, s-maxage=86400", // Edge cache popular search results
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

        // Validation: medications must be a non-empty array
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

        // Clean & normalize input medication names
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

        // ==============================================================
        // QUERY STEP 1: Map Brand Names to Active Ingredients (Compositions)
        // ==============================================================
        const placeholders = sanitizedMeds.map(() => "?").join(",");
        const { results: medsResults } = await env.DB.prepare(
          `SELECT brand_name, composition FROM medicines WHERE brand_name IN (${placeholders})`
        )
          .bind(...sanitizedMeds)
          .all();

        const compositionsMap = {};
        const uniqueIngredients = new Set();

        medsResults.forEach((row) => {
          compositionsMap[row.brand_name] = row.composition;
          // Split multi-ingredient compositions (e.g., "Aceclofenac, Paracetamol")
          const ingredients = row.composition.split(",").map((i) => i.trim());
          ingredients.forEach((i) => {
            if (i) uniqueIngredients.add(i);
          });
        });

        const ingredientsArray = Array.from(uniqueIngredients);

        // ==============================================================
        // QUERY STEP 2: Evaluate All Combinatorial Interactions
        // ==============================================================
        let interactions = [];
        if (ingredientsArray.length > 1) {
          const ingPlaceholders = ingredientsArray.map(() => "?").join(",");
          // Bind parameters for both drug1 IN (...) and drug2 IN (...)
          const bindValues = [...ingredientsArray, ...ingredientsArray];

          const { results: intResults } = await env.DB.prepare(
            `SELECT drug1, drug2, severity FROM interactions 
             WHERE drug1 IN (${ingPlaceholders}) AND drug2 IN (${ingPlaceholders})`
          )
            .bind(...bindValues)
            .all();

          interactions = intResults;
        }

        // Return structured result payload
        return new Response(
          JSON.stringify({
            compositions: compositionsMap,
            interactions: interactions,
            meta: {
              analyzedMedicationsCount: sanitizedMeds.length,
              identifiedIngredientsCount: ingredientsArray.length,
              interactionsFoundCount: interactions.length,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...corsHeaders,
            },
          }
        );
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

    // 5. Default 404 Route for Unmatched Requests
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
