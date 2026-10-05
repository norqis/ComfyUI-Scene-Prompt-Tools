# Civitai search and local LoRA picker

## Requested behavior

- In the local LoRA picker, group Civitai Search immediately to the left of Close at the right edge of the header.
- Unregistered local LoRAs use their filename as the title and a Local source button. Registered LoRAs retain the Civitai title and Civitai detail button. Lookup failure must not claim that a resource is registered or unregistered.
- Search results are preview cards, ten per row, in the server's ranking order. Keep card content compact; open details by clicking the card or pressing Enter/Space. Keep the header and filter controls visible and within the modal.
- Details show two preview images side by side. Previous/Next moves through pairs and preserves aspect ratios; handle zero, one and odd image counts. Below are Base Model, Trigger Words, Description, Published and Stats, together with the existing acquire/select action and source link.
- Back returns to exactly the previous results, query, filter values, ranking, selection and scroll position without another search.
- Search filters include Illustrious/Anima and civitai.com/civitai.red. Default to the Apply LoRA node's model kind and the previously saved host, or civitai.red for legacy state. The selected search host governs search, model links and acquisition. Searching does not edit the Apply LoRA node; selecting a candidate sets the node's matching model kind and prompts inside the existing undo transaction.

## Implementation

Use the existing search module and modal. Keep search and detail views in one modal, retain the result DOM while details are visible, and restore focus to the clicked card on Back. A full-width modal accommodates ten columns; a contained horizontal results scroller keeps ten columns usable in narrow windows without overflowing header buttons. No global result cache or new capacity limit. Disposing the modal drops images, result objects and pending request ownership.

The existing models API already returns descriptions, version images, publication dates and model/version statistics. Extend normalized candidates with the needed fields and all eligible preview URLs once per version; preserve the existing image eligibility rules. Missing fields display a dash. Render remote descriptions as text, not executable HTML. Do not send preview images or descriptions back to the LLM unnecessarily: its candidate prompt remains the existing compact shape.

The reviewed data contract uses description for model.description, version_description for version.description, published_at for the chosen version.publishedAt (createdAt only as a missing-date fallback), separate model_stats and version_stats, and an ordered gallery of eligible {url, width, height}. Keep the old stats/image_url fields for older consumers. Project only the existing compact candidate fields into LLM selection requests; full galleries/descriptions never enter them.

Add an optional validated host argument to search/download, defaulting to civitai.red. Accept only the two requested HTTPS origins and preserve old callers. Do not store a global host setting or add API keys. A model response may supply a canonical civitai.com download URL even when obtained from civitai.red; accept only an official /api/download/ path on either requested origin, route its initial request through the selected host, and retain the existing streaming/hash verification and redirect handling. Do not trust a client-supplied download URL.

Local hash lookup always tries civitai.red first, then civitai.com if the first lookup fails or has no match. Return not-found only when both confirm 404; if either host failed and neither found a match, preserve the error/unknown state so a temporary outage never becomes a negative cache entry. Keep this fallback separate from the search modal's explicit host choice. Test red success, red error/404 then com success, both 404, and mixed/all failures.

Keep query/sort/host/model kind in the existing small scene_civitai selection state; do not serialize result arrays, descriptions, galleries or transient modal state. Closing or changing filters invalidates obsolete responses. Changing host/model starts a new search and must not permit an old request to overwrite it. Failed search/download opens the existing error modal and retries only the still-current request. One download action stays busy until settled and cannot apply to a switched/deleted graph.

Capture query/sort/host/model_mode together when a request begins and use that immutable snapshot through ranking, details, retry, download and selection. Preserve the old result DOM on search failure. Back restores the results scroller's scrollLeft/scrollTop, modal scrollTop and card focus. Cards contain no nested actions; acquire/source actions belong in details. Local lookup has three states: found (Civitai), confirmed 404 (Local) and unknown/error (filename plus confirmation/retry state). Lookup errors are never negatively cached. Local is a status badge if it has no distinct action; the node's existing detail button remains available for local file metadata.

## Validation

- Chromium desktop: ten cards on the first row, card eleven on the next row; header search button adjacent to Close, no clipping with long names. Narrow viewport: controls and details stay inside the viewport, results use their own scroller.
- Click/keyboard card opens details; two images, Previous/Next boundaries, odd/zero/one image cases, text-only malicious HTML, complete metadata and missing metadata.
- Back preserves the original card DOM, search controls, ranking and scroll position, and makes no HTTP search request.
- Both model filters and both hosts reach the correct API origin; legacy absent-host calls default red; invalid host rejected. Selection changes model kind with the undo transaction and remains stale-graph safe.
- Undo/redo restores host, model kind, LoRA and triggers together. A download completing after Back, Close or deletion cannot overwrite stale state. Filter changes discard old responses; a failed search retains the previous grid and its scroll position. Model/version stats have distinct labels and are never mixed.
- Local fallback is filename plus Local after 404; cached Civitai match is title plus Civitai; errors preserve filename without mislabeling.
- Empty, truncated and HTML HTTP responses never escape as a raw JSON SyntaxError or become an empty successful result. Display the failed API and HTTP status in the existing error modal, preserve the current search state, and permit a retry. Cover 200-empty, 200-truncated, non-JSON errors and recovery in browser tests as well as malformed upstream JSON in backend tests.
- Existing LLM-selected state opens the search and retains selection. Existing search/download/retry/hash validation and GPU controller tests still pass. Actual isolated ComfyUI browser test exercises native picker and search modal; no production generation or GPU changes.

## Primary API evidence

- https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/models.md
- https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/model-versions.md
