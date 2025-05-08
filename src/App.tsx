import { z } from "zod";
import React, { FormEvent, useEffect, useState } from "react";
import OpenAI from "openai";

// MARK: Scrape Data

function assert(value: boolean, msg?: string | undefined): asserts value {
  if (!value) throw new Error(msg ?? "failed assertion");
}

const PER_PAGE_MIN = 1;
const PER_PAGE_MAX = 1000;

const HitSchema = z.object({
  sku: z.string().regex(/^$|^\d+$/),
  title: z.string(),
});

const QueryResultSchema = z.object({
  nbHits: z.number(),
  nbPages: z.number(),
  page: z.number(),
  hitsPerPage: z.number(),
  hits: z.array(HitSchema),
  index: z.string(),
});
type QueryResult = z.infer<typeof QueryResultSchema>;

const QueriesResultSchema = z.object({
  results: z.array(QueryResultSchema),
});

function params(object: Record<string, string>) {
  return new URLSearchParams(object).toString();
}

type FetchSearchPageInit = {
  query: string;
  page?: number;
  perPage?: number;
};

// TODO: Add some kind of retry timeout
// TODO: Handle failures gracefully?
async function fetchSearchPage({
  query,
  page = 0,
  perPage = 36,
}: FetchSearchPageInit): Promise<QueryResult> {
  assert(page >= 0);
  assert(perPage >= PER_PAGE_MIN);
  assert(perPage <= PER_PAGE_MAX);

  // Keeping this URL in tact so it's easier to replace if I ever want to update it.
  // Keeping the Algolia agent too so it doesn't look out of place in their analytics.
  // Last updated: Sat Apr 12 23:35:36 AEST 2025
  const url =
    "https://vtvkm5urpx-dsn.algolia.net/1/indexes/*/queries?x-algolia-agent=Algolia%20for%20JavaScript%20(4.24.0)%3B%20Browser%3B%20instantsearch.js%20(4.74.0)%3B%20react%20(18.3.1)%3B%20react-instantsearch%20(7.13.0)%3B%20react-instantsearch-core%20(7.13.0)%3B%20JS%20Helper%20(3.22.4)";

  const req = await fetch(url, {
    credentials: "omit",
    method: "POST",
    mode: "cors",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.5",
      "x-algolia-api-key": "1d989f0839a992bbece9099e1b091f07",
      "x-algolia-application-id": "VTVKM5URPX",
      "content-type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
      Pragma: "no-cache",
      "Cache-Control": "no-cache",
    },
    referrer: "https://www.jbhifi.com.au/",
    body: JSON.stringify({
      requests: [
        {
          indexName: "shopify_products_families",
          params: params({
            analytics: "false",
            clickAnalytics: "false",
            distinct: "true",
            facetFilters: JSON.stringify([["isMarketplace:false"]]),
            facets: "[]",
            // 62 is the department code for accessories
            filters:
              `product.departmentCode != 62 AND NOT category_hierarchy:"Game cards" AND NOT category_hierarchy:"Music" AND NOT category_hierarchy:"TV Shows" AND NOT category_hierarchy:"DJ & Musical Instruments" AND NOT category_hierarchy:"Movies" AND NOT category_hierarchy:"Merchandise" AND NOT facets.Condition:"Renewed" AND price > 0 AND product_published = 1 AND availability.displayProduct = 1`,
            highlightPostTag: "__/ais-highlight__",
            highlightPreTag: "__ais-highlight__",
            hitsPerPage: perPage.toString(),
            maxValuesPerFacet: "100",
            page: page.toString(),
            query: query,
            tagFilters: "",
          }),
        },
      ],
    }),
  });
  if (req.status !== 200) {
    const data = await req.text();
    throw new Error(`Unexpected status: ${req.status}, data: ${data}`);
  }
  const json = await req.json();
  const queriesResult = QueriesResultSchema.parse(json);
  assert(queriesResult.results.length === 1);
  return queriesResult.results[0];
}

type FetchAllSearchResultsInit = {
  query: string;
};

async function fetchSearchResults(init: FetchAllSearchResultsInit) {
  const { query } = init;

  const perPage = PER_PAGE_MAX;

  const page0 = await fetchSearchPage({
    page: 0,
    query,
    perPage,
  });

  if (page0.nbPages === 1) return page0.hits;

  const allHits = page0.hits;

  // Pages are 0-indexed, nbPages will always be 1 more than the
  // number of pages that you can request. If you request the
  // `nbPages`-th page, you'll get an empty array
  const promises: Promise<QueryResult>[] = [];
  for (let i = 1; i < page0.nbPages; i++) {
    promises.push(fetchSearchPage({ query, page: i, perPage }));
  }

  const resolved = await Promise.all(promises);
  for (const result of resolved) {
    allHits.push(...result.hits);
  }
  return allHits;
}

// MARK: OpenAI

const OPENAI_SYSTEM_PROMPT = `
Your input will be a JSON object containing a user query (\`query\`) and an object mapping product SKUs to product titles (\`products\`). Your task is to help salespeople check the stock of all related products at the same time by bucketing all the products with the same technical specifications together, usually differentiated by color, or maybe color and style.

You will convert the title strings into an array containing the attributes of the product, organized from most broad to most specific, which will require moving some attributes around.

The output you create will be used to group products together into a hierarchy, so it is important to be extremely consistent with your naming and formatting.

You must always finish with either a color (e.g. "Sky Blue") or a color and fit combination (e.g. "Starlight, S/M").

# Output

Your output must match the following TypeScript type definition for "Result":
\`\`\`typescript
type Result = { thinking: string; excluded: string[]; products: Record<string, string[]>; };
\`\`\`

Your thought process will be written in the \`thinking\` property, and the results will be written in the \`products\` property.

Your output does not have to include all the properties from each title, and does not have to contain all products if there are products that do not fit in.

# Steps

Write out your thinking in the \`thinking\` property. Do this first. Use proper markdown formatting so a human can read it.

- Identify the products that should be excluded from the results. These are products that don't fit in, such as accessories, or renewed/refurbished items. Use your natural language understanding to infer the intent of the search query, and exclude items that very clearly do not belong with that. Similar products (e.g. same product generation with a minor variation) should be included, such as differences in processor between computers.
- Write out the SKUs of the products that will be excluded.
- Identify the all of attributes of all the remaining items. You must use your knowledge of these products to identify what is and isn't important in the titles, and what information isn't actually part of the title that has clearly been added by the retailer. Explain this in your thinking.
  - For example, you know that on Pro models of iPhone, the material is included as part of the color, but on Apple Watch, the material is a sub-product-line.
  - Omit redundant information found in the title that is not actually part of the product name, such as the year or marketing copy, if it is not used to differentiate anything. In your thinking, show that you have identified and ignored or used these properties.
  - Omit information in the title that does not differentiate products, such as "5G" or "Wi-Fi + Cellular" in products that all have those attributes, must be omitted. Identify, for each attribute like this, whether it differentiates products.
  - NEVER omit critical information like the product's generation and storage/RAM.
- If there are products that specify both a color and material, identify the material and the color separately. Write out that you have identified these. For example, "Slate Titanium" is the color "slate" and the material "titanium".
- Organize these attributes per item: start from brand, then product line, then generation. Then, the remaining attributes, finally resulting in groups containing multiple products that have the same technical specifications but different colors.
- The order should generally go like this: Brand > Product Line > Sub-line, if applicable > Physical properties (NOT COLOR) ... > Technical properties... > Accessories / bundle details > Color and fit
- Ensure that if a product specifies both storage and RAM, that the storage and RAM are always grouped together, and the storage is always first. For example: "512GB/16GB", "1TB/32GB"
- For **at least** five products representative of the input, write out an example order so that you can assess whether the order you tried is good. Identify whether the color is last for all of them. If it is not, try again.
- Create the \`excluded\` array, containing only the SKUs of products that should be ignored. If there are no products to exclude, this array should be empty.
- Create the products object, following the information laid out during your thinking.

For Apple Watch specifically:
- NEVER combine the material and the color of Apple Watch products. "Silver Aluminium" is made of aluminium (colored as silver), "Gold Titanium" is made of titanium (colored as gold). You must NEVER create a group containing both the material and color for Apple Watch.
- NEVER include the material for Apple Watch SE or Apple Watch Ultra products. These are ALWAYS identical, the material will never EVER be used to differentiate them. You must ALWAYS identify the color of the material and ALWAYS include the color of the material, e.g. "Black Titanium" -> "Black".
- NEVER include the cellular connectivity for Apple Watch Ultra or the premium material Apple Watch Series (e.g. Steel, Titanium), as these will NEVER be used to differentiate them.
- NEVER include the screen or case size for Apple Watch Ultra, as this is ALWAYS identical between all models and will never differentiate them.

For Samsung specifically:
- Categorize "Galaxy" devices as "Galaxy S", "Galaxy A", "Galaxy Z", "Galaxy Tab S", "Galaxy Tab A", etc.

# Examples

Input: { "785320": "Apple Watch SE  40mm Midnight Aluminium Case GPS + Cellular Sport Band (M/L) [2024]" }
Thinking: Apple Watch SE models are not all from the same year, so I identified that this is the 2024 model. The model is more important than the material. Identified "Aluminium" as the material, and "Midnight" as the color. Aluminium will be omitted because I know that all Apple Watch SE models are aluminium. The color always goes last. Sport band is a specification of the product, so it gets its own position in the list, but M/L is information about its fit, so it is grouped with the color.
Output: { "785320": ["Apple, "Apple Watch", "SE (2024)", "40mm", "GPS + Cellular", "Sport Band", "Midnight, M/L"] }

---

Input: { "623415": "Apple Watch Series 10 42mm Silver Aluminium Case GPS Sport Band (M/L) [Denim]" }
Thinking: Apple Watch Series 10 models are either Titanium or Aluminium. This is an aluminium model. The color must be Silver, which I will put last, because the color and fit always go last. The band size is M/L and the color of the band is Denium, as shown by the square brackets.
Output: { "623415": ["Apple", "Apple Watch", "Series 10", "Aluminium", "42mm", "GPS", "Sport Band", "Silver, Denim, M/L"] }

---

Input: { "785338": "Apple Watch Series 10 46mm Natural Titanium Case  GPS + Cellular Milanese Loop (S/M)" }
Thinking: Omitted GPS + Cellular, because all Titanium Apple Watch models have it. Identified "Titanium" as the material (sub-identifier of product line as well), and "Natural" as the color. Because the color and fit go last, I will make the last attribute "Natural, S/M".
Output: { "785338": ["Apple, "Apple Watch", "Series 10", "Titanium", "46mm", "Milanese Loop", "Natural, S/M"] }

---

Input: { "785337": "Apple Watch SE 44mm Starlight Aluminium Case GPS + Cellular Sport Loop (Lake Green) [2024]" }
Thinking: I can identify that the product is an Apple Watch SE from 2024. Because SE by itself does not encode any useful information about when the watch was created, I will include the "2024" as part of this attribute, "SE (2024)". The color of the watch is Starlight, and the material is Aluminium. Aluminium will be omitted because I know that all Apple Watch SE models are aluminium. Colors always go last, so I will put Starlight last. I can see that the type of band is Sport Loop, which is Lake Green. I will include Starlight and Lake green in the final color attribute.
Output: { "785337": ["Apple", "Apple Watch", "SE (2024)", "44mm", "GPS + Cellular", "Sport Loop", "Starlight, Lake Green"] }

---

Input: { "656225": "Apple Watch Series 10 46mm Gold Titanium Case GPS + Cellular Sport Band (M/L)[Starlight]" }
Thinking: We can identify from the title that this is a Titanium Apple Watch, which is its own sub-product-line. Therefore, the color of the watch must be Gold. We will include this in the final color. The "[Starlight]" must be the color of the band, so this will also be included in the color, along with the fit. GPS + Cellular is omitted because all Titanium apple watches have it.
Output: { "656225": ["Apple", "Apple Watch", "Series 10", "Titanium", "46mm", "Sport Band", "Gold, Starlight, M/L"] }

---

Input: { "656205": "Apple Watch Series 10 42mm Natural Titanium Case GPS + Cellular Sport Band (M/L)[Stone Grey]" }
Thinking: We can identify from the title that this is a Titanium Apple Watch, which is its own sub-product-line. Therefore, the color of the watch must be Natural. We will include this in the final color. The "[Stone Grey]" must be the color of the band, so this will also be included in the color, along with the fit. GPS + Cellular is omitted because all Titanium apple watches have it.
Output: { "656205": ["Apple", "Apple Watch", "Series 10", "Titanium", "42mm", "Sport Band", "Natural, Stone Grey, M/L"] }

---

Input: { "796240": "Apple MacBook Air 15-inch with M4 Chip, 512GB/16GB (Midnight)" }
Thinking: Identified that the generation is the chip, M4. The next most important property is physical, which is the size. Then the specifications, which is Storage/RAM. Finally, the color.
Output: { "796240": ["Apple", "MacBook Air", "M4", "15-inch", "512GB/16GB", "Midnight"] }

---

Input: { "623421": "Apple Watch Series 10 42mm Rose Gold Aluminium Case GPS Sport Band (M/L) [Light Blush]" }
Thinking: The product is an Apple Watch, so the brand is Apple. The product line is Apple Watch, and the generation is Series 10. The physical properties include the case size (42mm) and the case material, which is Aluminium. The technical property GPS is included, but since not all Apple Watch models have GPS, it is relevant to keep. The band type is Sport Band. The color of the case is Rose Gold, which is a combination of color and material descriptor (Rose Gold is a color variant of Aluminium). The band color is Light Blush, indicated in brackets, and the fit size is M/L. The color and fit information should be grouped last. The order is: Brand > Product Line > Generation > Material > Size > Technical features > Band type > Color and fit. The final color and fit attribute will be 'Rose Gold, Light Blush, M/L'.
Output: { "623421": ["Apple", "Apple Watch", "Series 10", "Aluminium", "42mm", "GPS", "Sport Band", "Rose Gold, Light Blush, M/L"] }

---

Input: { "746483": "Apple iPhone 16 Pro Max 256GB (Black Titanium)" }
Thinking: We know that on an iPhone, the material is part of the color, NOT the product line. iPhone model lines and the generation are tied together, making each of 16, 16 Plus, 16 Pro, and 16 Pro Max different. "iPhone" should always be included in the name of the model line.
Output: { "746483": ["Apple, "iPhone", "iPhone 16 Pro Max", "256GB", "Black Titanium"] }

---

Input: { "663044": "Apple Watch Ultra 2 49mm Natural Titanium Case GPS + Cellular Ocean Band (Navy)" }
Thinking: All Apple Watch Ultra 2 models have 49mm Titanium cases, GPS + Cellular, and the same screen size, so these details are not differentiators and can be omitted. The material (Titanium) is also not used to differentiate Ultra models, so it will be omitted. The color of the case is given as 'Natural Titanium', but per instructions, for Apple Watch Ultra, the material is never included, and the color of the material is always included. So the color is 'Natural'. The watch color and the band color will be combined.
Output: { "663044": ["Apple", "Apple Watch", "Ultra 2", "Ocean Band", "Natural, Navy"] }

---

Input: { "663051": "Apple Watch Ultra 2 49mm Black Titanium Case GPS + Cellular Ocean Band" }
Thinking: All Apple Watch Ultra 2 models have 49mm Titanium cases, GPS + Cellular, and the same screen size, so these details are not differentiators and can be omitted. The material (Titanium) is also not used to differentiate Ultra models, so it will be omitted. The color of the case is given as 'Black Titanium', but per instructions, for Apple Watch Ultra, the material is never included, and the color of the material is always included. So the colors is 'Black'. There is no band color specified for this watch.
Output: { "663044": ["Apple", "Apple Watch", "Ultra 2", "Ocean Band", "Black"] }

---

Input: { "639228": "Apple iPhone 15 Pro Max 1TB (Natural Titanium)" }
Thinking: The product is an Apple iPhone, so the brand is Apple. The product line is iPhone, and the generation and model is '15 Pro Max'. The storage capacity is 1TB, which is an important technical specification. The color and material are combined as 'Natural Titanium', which is typical for iPhone Pro models where the material is part of the color description. The order should be Brand > Product Line > Model > Storage > Color and material.
Output: { "639228": ["Apple", "iPhone", "iPhone 15 Pro Max", "1TB", "Natural Titanium"] }

---

Input: { "749794": "Microsoft Surface Pro (11th Edition) Copilot+ PC 13\\" Snapdragon X Plus 10 core/16GB/512GB (Black)" }
Thinking: We know that "Copilot+ PC" is just marketing copy, but even if we didn't know that, it's in each product title so it isn't used to differentiate any of them. The Storage/RAM was in the wrong order, so that has been corrected. For consistency with every product, I must make sure that Storage always comes before RAM.
Output: { "749794": ["Microsoft, "Surface Pro", "11th Edition", "13\\"", "Snapdragon X Plus 10 core", "512GB/16GB", "Black"] }

---

Input: { "795468": "Samsung Galaxy S25 Ultra 256GB (Titanium Black)" }
Thinking: The brand is Samsung, and we know the model of phone is Galaxy S25 Ultra by understanding how phones are named. Ultra is a size.
Output: { "795468": ["Samsung, "Galaxy S25 Ultra", "256GB", "Titanium Black"] }

---

Input: { "785122": "Apple Watch 42mm [Ink] Sport Loop" }
Thinking: The way the title starts makes this look like an Apple Watch, but there are no details about the watch component, so it is significantly more likely that this is actually a watch band. Since that is an accessory, I will exclude this.
Output: {}

---

Input: { "676261": "Apple Watch Ultra 49mm Ocean Band (Blue)" }
Thinking: The title looks like an Apple Watch, but it does not include any of the details that the product title of an Apple Watch would include, so I can conclude that this is an accessory watch band. I will exclude this from my output.
Output: {}

---

Input: { "686825": "Apple iMac with Retina 4.5K Display 24-inch, M4 Chip 10-core 512GB/24GB (Silver)[2024]" }
Thinking: The title contains the attributes "Retina 4.5K Display" and "24-inch", but these are common to all iMac models, so following my instructions, they can be omitted entirely as they are redundant. The generation is denoted by the chip, which is M4.
Output: { "686825": ["Apple", "iMac", "M4", "10-core", "512GB/24GB", "Silver"] }
`.trim();

const ResultsSchema = z.object({
  thinking: z.string(),
  excluded: z.array(z.string()),
  products: z.record(z.string(), z.array(z.string())),
});

type Result = z.infer<typeof ResultsSchema>;

interface LLMMessageInit {
  productList: Record<string, string>;
  query: string;
}

async function gptProcessProducts(
  client: OpenAI,
  init: LLMMessageInit,
): Promise<Result> {
  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text: OPENAI_SYSTEM_PROMPT,
        }],
      },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify(
            { query: init.query, products: init.productList },
            null,
            2,
          ),
        }],
      },
    ],
    text: { format: { type: "json_object" } },
    reasoning: {},
    tools: [],
    temperature: 0.2,
    top_p: 0.1,
    store: true,
  });

  const outputJson = JSON.parse(response.output_text);
  const result = ResultsSchema.parse(outputJson);
  return result;
}

// MARK: Output

type Group<SKU, Attribute> = Map<Attribute, Group<SKU, Attribute> | SKU[]>;

function groupByAttributes<SKU extends string, Attribute extends string>(
  products: Record<SKU, Attribute[]>,
): Group<SKU, Attribute> {
  const tree: Group<SKU, Attribute> = new Map();

  for (
    const [sku, attributes] of Object.entries(products) as [
      SKU,
      Attribute[],
    ][]
  ) {
    let currentLevel = tree;

    for (let i = 0; i < attributes.length; i++) {
      const attr = attributes[i];
      const existing = currentLevel.get(attr);

      if (existing === undefined) {
        if (i === attributes.length - 1) {
          currentLevel.set(attr, [sku]);
        } else {
          const nextLevel: Group<SKU, Attribute> = new Map();
          currentLevel.set(attr, nextLevel);
          currentLevel = nextLevel;
        }
      } else {
        if (i === attributes.length - 1) {
          if (Array.isArray(existing)) {
            existing.push(sku);
          } else {
            console.error(sku, attributes, existing);
            throw new Error(
              `Expected list of SKUs at node ${
                JSON.stringify(attributes)
              }, but got a Map: ${sku}`,
            );
          }
        } else {
          if (existing instanceof Map) {
            currentLevel = existing;
          } else {
            throw new Error(
              `Expected Map at non-leaf node, got an array at "${attr}"`,
            );
          }
        }
      }
    }
  }

  return tree;
}

function groupToBookmarksHTML<SKU extends string, Attribute extends string>(
  group: Group<SKU, Attribute>,
): string {
  const indent = "    ";
  const escapeHTML = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function recurse(node: Group<SKU, Attribute>, indentLevel: number): string {
    const indentStart = "    ".repeat(indentLevel);
    const lines: string[] = [`${indentStart}<DL><p>`];

    for (const [key, value] of node.entries()) {
      if (Array.isArray(value)) {
        assert(value.length > 0, `array had no SKUs: key=${key}`);
        const uniqueSkus = new Set(value);
        for (const sku of uniqueSkus.values()) {
          const title = uniqueSkus.size === 1
            ? escapeHTML(key)
            : `${escapeHTML(key)} ${sku}`;
          const href = `https://products.jbhifi.tech/au/product/${
            encodeURIComponent(
              sku,
            )
          }`;
          lines.push(
            `${indentStart}${indent}<DT><A HREF="${href}">${title}</A>`,
          );
        }
      } else {
        lines.push(
          `${indentStart}${indent}<DT><H3 ADD_DATE="0" LAST_MODIFIED="0">${
            escapeHTML(key)
          }</H3>`,
        );
        lines.push(recurse(value, indentLevel + 1));
      }
    }

    lines.push(`${indentStart}</DL><p>`);
    return lines.join("\n");
  }

  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${recurse(group, 0)}
</DL><p>`;
}

// MARK: React App

const DeleteIcon: React.FC = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="size-4 fill-black/50 hover:fill-black"
  >
    <path d="M16.7384 1.06071C17.3242 0.474966 18.2737 0.474968 18.8595 1.06071C19.4453 1.64648 19.4452 2.59601 18.8595 3.1818L12.0812 9.96012L18.7384 16.6173C19.324 17.2032 19.3241 18.1527 18.7384 18.7384C18.1527 19.3242 17.2031 19.324 16.6173 18.7384L9.96008 12.0812L3.30286 18.7384C2.71705 19.324 1.76746 19.3241 1.18176 18.7384C0.596101 18.1527 0.596247 17.2031 1.18176 16.6173L7.83899 9.96012L1.06067 3.1818C0.474952 2.59601 0.474906 1.64647 1.06067 1.06071C1.64643 0.474944 2.59597 0.47499 3.18176 1.06071L9.96008 7.83903L16.7384 1.06071Z" />
  </svg>
);

const SpinnerIcon: React.FC = () => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="size-5 animate-spin text-black/70"
  >
    <circle
      cx="12"
      cy="12"
      r="8"
      stroke="currentColor"
      strokeOpacity="0.5"
      strokeWidth="4"
    />
    <path
      d="M20 12C20 7.58172 16.4183 4 12 4C9.86958 4 7.93366 4.83275 6.5 6.1905"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
    />
  </svg>
);

interface DownloadInit {
  fileName: string;
  mimeType: string;
  text: string;
}

function download(init: DownloadInit) {
  const blob = new Blob([init.text], { type: init.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = init.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function searchAndAnalyze(client: OpenAI, query: string) {
  const searchResults = await fetchSearchResults({ query });

  if (searchResults.length === 0) {
    throw new Error("No search results found");
  }

  const sortedResults = searchResults
    .concat().sort((a, b) => a.title.localeCompare(b.title));

  const productList = sortedResults.reduce((acc, curr) => ({
    ...acc,
    [curr.sku]: curr.title,
  }), {} as Record<string, string>);

  const productTitleAttributes = await gptProcessProducts(client, {
    query,
    productList,
  });

  return productTitleAttributes;
}

type ProductAnalysis =
  | PendingProductAnalysis
  | CompleteProductAnalysis
  | FailedProductAnalysis;

interface PendingProductAnalysis {
  status: "pending";
  id: string;
  query: string;
  products: null;
}

const CompleteProductAnalysisSchema = z.object({
  status: z.literal("complete"),
  id: z.string(),
  query: z.string(),
  products: z.record(z.string(), z.array(z.string())),
});

interface CompleteProductAnalysis {
  status: "complete";
  id: string;
  query: string;
  products: Record<string, string[]>;
}

interface FailedProductAnalysis {
  status: "failed";
  id: string;
  query: string;
  products: null;
}

const SearchResult: React.FC<
  { item: ProductAnalysis; deleteItem: (id: string) => void }
> = ({ item, deleteItem }) => {
  const totalProducts = item.status === "complete"
    ? Object.keys(item.products).length
    : 0;
  return (
    <div className="w-full border-black/10 border rounded-lg h-20 flex items-center px-4">
      <div className="w-full">
        <div className="font-medium">{item.query}</div>
        <div className="text-sm text-gray-700">
          {item.status === "pending"
            ? "Processing..."
            : item.status === "complete"
            ? `Completed, ${totalProducts} product${
              totalProducts === 1 ? "" : "s"
            } found`
            : "Processing failed"}
        </div>
      </div>
      <div className="w-5 flex justify-center items-center">
        {item.status !== "pending"
          ? (
            <button
              onClick={() => deleteItem(item.id)}
              aria-label="Delete results"
            >
              <DeleteIcon />
            </button>
          )
          : <SpinnerIcon />}
      </div>
    </div>
  );
};

const SearchResultList: React.FC<
  { items: ProductAnalysis[]; deleteItem: (id: string) => void }
> = ({ items, deleteItem }) => {
  const hasCompletedSearches = items.some((item) => item.status === "complete");

  const handleDownload = () => {
    const all: Record<string, string[]> = {};
    for (const item of items) {
      if (item.status !== "complete") continue;
      for (const [sku, attributes] of Object.entries(item.products)) {
        all[sku] = attributes;
      }
    }
    const tree = groupByAttributes(all);
    const bookmarks = groupToBookmarksHTML(tree);

    download({
      fileName: "products-app-bookmarks.html",
      mimeType: "text/html",
      text: bookmarks,
    });
  };

  return (
    <div className="w-full flex flex-col items-center md:overflow-y-auto p-8">
      {items.length === 0
        ? (
          <div className="opacity-75 max-w-lg space-y-4 text-center">
            <p>No searches yet. Enter a query to get started.</p>
            <p className="italic opacity-50">
              For the best results, specify a product line and model, such as
              <br />
              "iphone 16", "ipad air m3", "macbook air m4", "surface pro", etc.
            </p>
          </div>
        )
        : (
          <div className="space-y-4 mb-6 w-full lg:max-w-xl">
            {items.map((item) => (
              <SearchResult key={item.id} item={item} deleteItem={deleteItem} />
            ))}
          </div>
        )}
      <button
        className="mt-auto w-full xl:w-lg transition-all border-2 border-[#028702] bg-[#028702] hover:bg-[#006e00] disabled:bg-[#f5f5f5] disabled:text-black disabled:border-2 disabled:border-gray-500 disabled:cursor-not-allowed jb-btn-shadow disabled:opacity-50 text-white py-3 px-6 font-bold"
        disabled={!hasCompletedSearches}
        onClick={handleDownload}
      >
        Download Bookmarks
      </button>
    </div>
  );
};

const TextCallout: React.FC<{ children: string }> = ({ children }) => (
  <span className="bg-gray-200 py-1 px-2 rounded-lg border border-black/10 whitespace-nowrap">
    {children}
  </span>
);

const SearchForm: React.FC<{
  doSearch: (query: string, apiKey: string) => void;
  statusMessage: string;
  setStatusMessage: (message: string) => void;
  isSearching: boolean;
}> = ({ doSearch, statusMessage, setStatusMessage }) => {
  const [apiKey, setApiKey] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!searchQuery.trim()) {
      setStatusMessage("A search query is required.");
      return;
    }

    if (!apiKey || apiKey.length < 40) {
      setStatusMessage("An OpenAI API key is required.");
      return;
    }

    doSearch(searchQuery, apiKey);

    // Clear the search input
    setSearchQuery("");
  };

  return (
    <div className="w-full p-8 flex flex-col md:relative bg-[#f5f5f5]">
      {/* Right alignment */}
      <div className="w-full max-w-xl ml-auto flex flex-col h-full">
        <div className="flex-grow flex flex-col justify-center">
          {/* Text introduction */}
          <div className="mb-8 space-y-4 leading-8">
            <h1 className="text-2xl font-bold mb-2">
              Products App Bookmark Generator
            </h1>
            <p className="text-gray-700">
              Create a bookmark folder with links to Products App, grouping like
              products by their color and style, allowing you to check stock for
              an entire range of products instantly.
            </p>
            <h2 className="text-xl font-semibold mb-2">Importing</h2>
            <p className="text-gray-700">
              To import the bookmarks, first download the file, then right click
              the bookmarks bar at the top, and select{" "}
              <TextCallout>Bookmark Manager</TextCallout>. Click the top-right
              menu <TextCallout>⋮</TextCallout> then select{" "}
              <TextCallout>Import bookmarks</TextCallout>, and choose the file
              you downloaded.
            </p>
          </div>

          {/* Inputs */}
          <form onSubmit={handleSubmit} className="w-full">
            <div className="mb-6">
              <label
                htmlFor="apiKey"
                className="block text-lg font-medium mb-2"
              >
                OpenAI API Key
              </label>
              <input
                type="password"
                data-1p-ignore
                id="apiKey"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full border-black/10 p-2 outline-none focus:border-black border-2"
              />
            </div>

            <div className="mb-6">
              <label
                htmlFor="searchQuery"
                className="block text-lg font-medium mb-2"
              >
                Search query
              </label>
              <input
                type="text"
                id="searchQuery"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full border-black/10 p-2 outline-none focus:border-black border-2"
              />
            </div>

            <button
              type="submit"
              className="bg-black border-black border-2 hover:bg-[#222222] transition-all text-white py-3 px-6 w-full jb-btn-shadow"
            >
              Analyze Products
            </button>
          </form>
        </div>

        {/* Status */}
        <div className="mt-6">
          {statusMessage}
        </div>
      </div>
    </div>
  );
};

const loadSavedProducts = (): ProductAnalysis[] => {
  const products = localStorage.getItem("products");
  if (products === null) {
    return [];
  }
  try {
    const savedJson = JSON.parse(products);
    const parsed = z.array(CompleteProductAnalysisSchema).parse(savedJson);
    return parsed;
  } catch (err) {
    console.error(
      "Failed to parse saved values, resetting saved state to empty",
      err,
    );
    localStorage.setItem("products", "[]");
    return [];
  }
};

const App: React.FC = () => {
  const [productSearchResults, setProductSearchResults] = useState(
    loadSavedProducts(),
  );
  const [isSearching, setIsSearching] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  // This function
  const handleSearch = async (query: string, apiKey: string) => {
    setIsSearching(true);
    const id = Date.now().toString();
    const products: ProductAnalysis = {
      status: "pending",
      query: query,
      id,
      products: null,
    };

    // Add the new item to the list
    setProductSearchResults((prev) => [products, ...prev]);

    // Since users bring their own key, there's no other way to do this without
    // also setting up a backend and having users send their keys to it.
    const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
    try {
      const results = await searchAndAnalyze(client, query);
      console.log(query, results.thinking);
      console.debug(query, results.products);

      // The order of items may have changed, so it's important to find the
      // current index.
      setProductSearchResults((prev) => {
        const idx = prev.findIndex((item) => item.id === id);
        const newList = prev.concat();
        newList[idx] = {
          status: "complete",
          query,
          id,
          products: results.products,
        };
        return newList;
      });
    } catch (_err) {
      setProductSearchResults((prev) => {
        const idx = prev.findIndex((item) => item.id === id);
        const newList = prev.concat();
        newList[idx] = {
          status: "failed",
          query,
          id,
          products: null,
        };
        return newList;
      });
    }
  };

  useEffect(() => {
    console.debug("Updated saved values with current values");
    localStorage.setItem(
      "products",
      JSON.stringify(
        productSearchResults.filter((item) => item.status === "complete"),
      ),
    );
  }, [productSearchResults]);

  useEffect(() => {
    if (statusMessage) {
      const id = setTimeout(() => setStatusMessage(""), 5000);
      return () => clearTimeout(id);
    }
  }, [statusMessage]);

  useEffect(() => {
    const handler = (e: Event) => {
      const anyPending = productSearchResults.some((item) =>
        item.status === "pending"
      );
      if (anyPending) {
        e.preventDefault();
        return;
      }
    };
    window.onbeforeunload = handler;
    return () => {
      if (window.onbeforeunload === handler) {
        window.onbeforeunload = null;
      }
    };
  });

  const handleDeleteItem = (id: string) => {
    setProductSearchResults((prevItems) =>
      prevItems.filter((item) => item.id !== id)
    );
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white">
      <SearchForm
        doSearch={handleSearch}
        isSearching={isSearching}
        statusMessage={statusMessage}
        setStatusMessage={setStatusMessage}
      />
      <SearchResultList
        items={productSearchResults}
        deleteItem={handleDeleteItem}
      />
    </div>
  );
};

export default App;
