import unittest
from pathlib import Path
from unittest import mock

from test_civitai import civitai, civitai_auth


class CivitaiImageDetailsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.auth = mock.patch.object(civitai_auth, "token_snapshot", return_value="fixture-search-key")
        self.token_mock = self.auth.start()
        self.addCleanup(self.auth.stop)
        self.site = mock.patch.object(civitai, "_site_search", return_value={"hits": [{"id": 1}], "facetDistribution": {"category.name": {"Style": 5, "Action": 3}}})
        self.site_mock = self.site.start()
        self.addCleanup(self.site.stop)

    def preview(self, **fields):
        return {"id": 7, "url": "https://image.civitai.com/example/7.jpeg", "nsfw": False, "nsfwLevel": 1, **fields}

    def test_preview_gate_and_trusted_filename_identity(self):
        for level in (0, 1, 2, 4, 8, 16, "None", "Soft", "Mature", "X", "XXX"):
            self.assertEqual(civitai.normalize_preview(self.preview(nsfw=True, nsfwLevel=level, browsingLevel=31))["id"], 7)
        self.assertIsNone(civitai.normalize_preview(self.preview(type="video")))
        self.assertEqual(civitai.normalize_preview({"url": "https://image.civitai.com/hash/123.jpeg"})["id"], 123)
        for url in ("https://example.com/123.jpeg", "https://image.civitai.com.evil/123.jpeg", "https://image.civitai.com/hash/preview.jpeg"):
            self.assertNotIn("id", civitai.normalize_preview({"url": url, "meta": {"prompt": "kept"}}))
            self.assertEqual(civitai.normalize_preview({"url": url, "meta": {"prompt": "kept"}})["meta"], {"prompt": "kept"})

    async def test_gallery_filters_version_and_public_stills_without_generation_queries(self):
        response = {"items": [self.preview(), self.preview(id=8, modelVersionId=88), self.preview(id=9, type="video"),
                               self.preview(id=10, nsfwLevel=4), self.preview(id=11, nsfwLevel="None", modelVersionIds=[22])],
                    "metadata": {"nextCursor": "next cursor"}}
        with mock.patch.object(civitai, "api_get", return_value=response) as get:
            result = await civitai.gallery(22, host="civitai.com", cursor="page")
        self.assertEqual([image["id"] for image in result["items"]], [7, 10, 11])
        self.assertEqual(result["next_cursor"], "next cursor")
        get.assert_awaited_once_with("/api/v1/images", {"modelVersionId": 22, "browsingLevel": "31", "type": "image", "cursor": "page"}, host="civitai.com", token="fixture-search-key")

    async def test_presentation_accepts_fileless_models_without_local_inventory_or_hash(self):
        model = {"id": 1, "name": "Model", "type": "Checkpoint", "modelVersions": [{"id": 2, "name": "Version", "images": [self.preview()]}]}
        with mock.patch.object(civitai, "api_get", return_value=model), \
                mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local inventory")), \
                mock.patch.object(civitai, "_sha256", side_effect=AssertionError("hash")):
            result = await civitai.details(1, 2)
        self.assertEqual(result["name"], "Model")
        self.assertEqual(result["model_type"], "Checkpoint")
        self.assertEqual(result["gallery"][0]["id"], 7)

    async def test_details_optional_index_date_uses_current_user_and_exact_model(self):
        model = {"id": 1, "name": "Name", "type": "LORA", "creator": {"username": "Author"},
                 "createdAt": "2020-01-01T00:00:00Z", "modelVersions": [{"id": 2}]}
        self.site_mock.return_value = {"hits": [{"id": 99, "lastVersionAt": "2026-01-01T00:00:00Z"}, {"id": 1, "lastVersionAt": "2025-02-03T00:00:00Z"}]}
        with mock.patch.object(civitai, "api_get", return_value=model) as get:
            result = await civitai.details(1, 2, "civitai.red", user_id="alice")
        self.assertEqual(result["updated_at"], "2025-02-03T00:00:00Z")
        self.assertEqual(result["creator_name"], "Author")
        self.token_mock.assert_called_with("alice")
        get.assert_awaited_once_with("/api/v1/models/1", host="civitai.red", token="fixture-search-key")
        self.site_mock.assert_awaited_once_with({"indexUid": "models_v9", "q": "", "filter": "id = 1", "limit": 1, "attributesToRetrieve": ["id", "lastVersionAt"]}, "civitai.red", "fixture-search-key")
        for optional in ({}, {"hits": []}, {"hits": [{"id": True, "lastVersionAt": "2025-02-03T00:00:00Z"}]}):
            with self.subTest(optional=optional), mock.patch.object(civitai, "api_get", return_value=model), mock.patch.object(civitai, "_site_search", side_effect=optional if isinstance(optional, Exception) else None, return_value=optional):
                self.assertIsNone((await civitai.details(1, 2))["updated_at"])
        with mock.patch.object(civitai, "api_get", side_effect=civitai.DownloadAccessError("auth")), mock.patch.object(civitai_auth, "token_snapshot", return_value="") as token, mock.patch.object(civitai, "_site_search") as site:
            with self.assertRaises(civitai.DownloadAccessError): await civitai.details(1, 2, user_id="bob")
            token.assert_called_once_with("bob"); site.assert_not_called()
        model["modelVersions"][0]["updatedAt"] = "2026-01-01T00:00:00Z"
        with mock.patch.object(civitai, "api_get", return_value=model), mock.patch.object(civitai, "_site_search") as site:
            self.assertEqual((await civitai.details(1, 2))["updated_at"], "2026-01-01T00:00:00Z"); site.assert_not_called()

    async def test_image_gate_precedes_generation_data(self):
        for image in (self.preview(id=8), self.preview(type="video")):
            with self.subTest(image=image), mock.patch.object(civitai, "api_get", return_value={"items": [image]}) as get:
                with self.assertRaises(civitai.ServiceError):
                    await civitai.image_details(7)
                self.assertEqual(get.await_count, 1)
                self.assertEqual(get.await_args.args[0], "/api/v1/images")

    async def test_nested_metadata_generation_priority_and_distinct_negative(self):
        rest = self.preview(meta={"id": 7, "meta": {"prompt": "REST positive", "negativePrompt": "REST negative", "tags": ["public tag"], "seed": 4, "workflow": {"nodes": []}}})
        generation = {"params": {"prompt": "Generation positive <script>text</script>", "negativePrompt": "Generation negative", "steps": 20},
                      "resources": [{"id": 99, "name": "v2", "model": {"id": 88, "name": "LoRA title", "type": "LORA"}, "strength": 0.7}]}
        with mock.patch.object(civitai, "api_get", side_effect=[{"items": [rest]}, generation]) as get:
            result = await civitai.image_details(7, "civitai.com")
        self.assertEqual(result["prompt"], "Generation positive <script>text</script>")
        self.assertEqual(result["negative_prompt"], "Generation negative")
        self.assertEqual(result["tags"], ["public tag"])
        self.assertEqual(result["resources"], [{"name": "LoRA title", "version_name": "v2", "type": "LORA", "strength": 0.7,
                                                "url": "https://civitai.com/models/88?modelVersionId=99"}])
        self.assertEqual(result["other"], {"seed": 4, "steps": 20})
        for key in ("prompt", "negativePrompt", "tags", "resources", "meta"):
            self.assertNotIn(key, result["other"])
        self.assertFalse(result["partial"])
        self.assertNotIn("meta", result["image"])
        self.assertNotIn("workflow", str(result))
        self.assertEqual(get.await_args.args, ("/api/generation/data", {"type": "image", "id": 7}))

    def test_other_metadata_has_only_seven_scalar_fields_in_order(self):
        image = {"width": 1024, "height": 768, "createdAt": "image date", "seed": 99, "sampler": "image sampler", "steps": 10, "cfgScale": 9,
                 "url": "private URL", "user": {"name": "excluded"}, "stats": {"likes": 1}, "workflow": {"nodes": []},
                 "meta": {"width": 2048, "height": 1536, "createdAt": "flat date", "seed": 8, "sampler": "flat sampler", "steps": 15, "cfgScale": 7,
                          "meta": {"width": 3072, "height": None, "createdAt": None, "seed": 6, "sampler": "nested sampler", "steps": 18, "cfgScale": 5}}}
        params = {"width": None, "height": 0, "createdAt": None, "seed": 0, "sampler": None, "steps": None, "cfgScale": 0,
                  "prompt": "positive", "negativePrompt": "negative", "tags": ["tag"], "workflow": {"nodes": []}, "extra": "excluded"}
        result = civitai._image_information(image, {"params": params}, "civitai.red")
        self.assertEqual(list(result["other"]), ["width", "height", "createdAt", "seed", "sampler", "steps", "cfgScale"])
        self.assertEqual(result["other"], {"width": 3072, "height": 0, "createdAt": "flat date", "seed": 0, "sampler": "nested sampler", "steps": 18, "cfgScale": 0})
        self.assertEqual(civitai._image_information({"meta": {"seed": [], "steps": {}, "cfgScale": 0}}, {}, "civitai.red")["other"], {"cfgScale": 0})
        preview = civitai.normalize_preview(self.preview(createdAt="2026-11-15T00:00:00Z"))
        self.assertEqual(preview["createdAt"], "2026-11-15T00:00:00Z")

    async def test_flat_metadata_survives_partial_generation_failure_without_inventing_tags(self):
        image = self.preview(meta={"prompt": "positive", "negativePrompt": "negative", "seed": 5})
        with mock.patch.object(civitai, "api_get", side_effect=[{"items": [image]}, civitai.ServiceError("offline")]):
            result = await civitai.image_details(7)
        self.assertTrue(result["partial"])
        self.assertEqual((result["prompt"], result["negative_prompt"]), ("positive", "negative"))
        self.assertIsNone(result["tags"])

    async def test_invalid_ids_and_hosts_do_not_make_requests(self):
        with mock.patch.object(civitai, "api_get") as get:
            for invalid in (0, -1, True, "7", 7.5, None):
                for function, args in ((civitai.gallery, (invalid,)), (civitai.details, (1, invalid)), (civitai.image_details, (invalid,))):
                    with self.subTest(function=function.__name__, invalid=invalid), self.assertRaises(ValueError):
                        await function(*args)
            for function, args in ((civitai.gallery, (7,)), (civitai.details, (1, 2)), (civitai.image_details, (7,))):
                with self.assertRaises(ValueError):
                    await function(*args, host="other.example")
            get.assert_not_called()

    async def test_browse_types_all_and_tags_do_not_access_local_files(self):
        checkpoint = {"id": 1, "type": "Checkpoint", "name": "Checkpoint", "stats": {"downloadCount": "invalid"},
                      "modelVersions": [{"id": 2, "baseModel": "Illustrious", "updatedAt": "2026-11-15T12:00:00Z"}]}
        with mock.patch.object(civitai, "api_get", return_value={"items": [checkpoint]}) as get, \
                mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local inventory")):
            result = await civitai.search("cat", "", model_type="Checkpoint", category="Style")
        self.assertFalse(result["items"][0]["installable"])
        self.assertEqual(result["items"][0]["model_stats"]["downloadCount"], "invalid")
        self.assertEqual(result["items"][0]["updated_at"], "2026-11-15T12:00:00Z")
        self.assertNotIn("baseModels", get.await_args.args[1])
        query = self.site_mock.await_args.args[0]
        self.assertIn('type = "Checkpoint"', query["filter"])
        self.assertIn('category.name = "Style"', query["filter"])
        self.assertEqual(get.await_args.args[1], {"ids": [1], "limit": 30, "nsfw": "true"})
        with mock.patch.object(civitai, "api_get", return_value={"ModelType": ["Checkpoint", "LORA", "CLIP"]}):
            self.assertEqual(await civitai.options(), {"model_types": ["Checkpoint", "LORA", "CLIP"], "categories": ["Style", "Action"]})
        with mock.patch.object(civitai, "api_get", return_value={"items": [{"name": "Style"}, {"name": "Action"}]}):
            self.assertEqual(await civitai.tags("sty"), {"items": ["Style", "Action"]})
        for function, malformed in ((civitai.options, {}), (civitai.options, {"ModelType": {}}),
                                    (civitai.tags, {}), (civitai.tags, {"items": {}})):
            with self.subTest(function=function.__name__, malformed=malformed), mock.patch.object(civitai, "api_get", return_value=malformed):
                with self.assertRaises(civitai.ServiceError):
                    await function()

    def test_updated_date_uses_real_version_then_model_timestamp_only(self):
        model = {"updatedAt": "2026-10-15T12:00:00Z"}
        self.assertEqual(civitai._updated_at(model, {"updatedAt": "2026-11-15T12:00:00Z"}), "2026-11-15T12:00:00Z")
        self.assertEqual(civitai._updated_at(model, {"updatedAt": "not a date"}), model["updatedAt"])
        self.assertIsNone(civitai._updated_at({}, {"publishedAt": "2026-11-15T12:00:00Z", "createdAt": "2026-11-15T12:00:00Z"}))

    async def test_all_compatible_lora_derives_apply_mode_but_unsupported_base_stays_browse_only(self):
        model = {"id": 1, "type": "LORA", "name": "LoRA", "modelVersions": [{"id": 2, "baseModel": "Illustrious XL",
                 "files": [{"id": 3, "name": "model.safetensors", "type": "Model", "hashes": {"SHA256": "a" * 64}, "downloadUrl": "https://civitai.red/api/download/models/2"}]}]}
        with mock.patch.object(civitai, "api_get", return_value={"items": [model]}) as get, \
                mock.patch.object(civitai, "lora_root", return_value=Path("unused")), \
                mock.patch.object(civitai, "_manifest", return_value={}), mock.patch.object(civitai, "_existing", return_value=""):
            result = await civitai.search("", "")
        self.assertTrue(result["items"][0]["installable"])
        self.assertEqual(result["items"][0]["apply_model_mode"], "Illustrious")
        self.assertNotIn("baseModels", get.await_args.args[1])
        model["modelVersions"][0]["baseModel"] = "unsupported"
        with mock.patch.object(civitai, "api_get", return_value={"items": [model]}), \
                mock.patch.object(civitai, "lora_root", side_effect=AssertionError("local inventory")), \
                mock.patch.object(civitai, "_sha256", side_effect=AssertionError("hash")):
            result = await civitai.search("", "")
        self.assertFalse(result["items"][0]["installable"])


if __name__ == "__main__":
    unittest.main()
