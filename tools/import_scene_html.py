from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = BASE_DIR / "data"

BLOCK_RE = re.compile(
    r"<(?P<tag>h2|h3)\b[^>]*>(?P<head>.*?)</(?P=tag)>|(?P<figure><figure\b[^>]*>.*?</figure>)",
    re.IGNORECASE | re.DOTALL,
)
ROW_RE = re.compile(r"<tr\b[^>]*>.*?</tr>", re.IGNORECASE | re.DOTALL)
CELL_RE = re.compile(r"<(?P<tag>td|th)\b[^>]*>(?P<body>.*?)</(?P=tag)>", re.IGNORECASE | re.DOTALL)
CODE_RE = re.compile(r"<code\b[^>]*>(.*?)</code>", re.IGNORECASE | re.DOTALL)
SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
BUTTON_RE = re.compile(r"<button\b[^>]*>.*?</button>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>", re.DOTALL)
BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
SPACE_RE = re.compile(r"[ \t\r\n\u3000]+")
INVALID_PATH_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def clean_text(value: str) -> str:
    value = SCRIPT_STYLE_RE.sub(" ", value or "")
    value = BR_RE.sub("\n", value)
    value = TAG_RE.sub(" ", value)
    value = html.unescape(value)
    return SPACE_RE.sub(" ", value).strip()


def clean_cell(value: str) -> str:
    return clean_text(BUTTON_RE.sub(" ", value or ""))


def prompt_from_cell(value: str) -> str:
    code_values = [clean_text(match.group(1)) for match in CODE_RE.finditer(value or "")]
    code_values = [item for item in code_values if item]
    if code_values:
        return ", ".join(code_values)
    return clean_cell(value)


def safe_dir_name(value: str, default_name: str) -> str:
    name = clean_text(value) or default_name
    name = INVALID_PATH_CHARS_RE.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:100] or default_name


def stable_suffix(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()[:8]


def cells_from_row(row_html: str) -> list[tuple[str, str]]:
    return [(match.group("tag").lower(), match.group("body")) for match in CELL_RE.finditer(row_html)]


def find_column(headers: list[str], keywords: tuple[str, ...]) -> int | None:
    for index, header in enumerate(headers):
        folded = header.lower()
        if any(keyword.lower() in folded for keyword in keywords):
            return index
    return None


def extract_table_items(figure_html: str) -> list[dict[str, str]]:
    rows = [cells_from_row(row.group(0)) for row in ROW_RE.finditer(figure_html)]
    rows = [row for row in rows if row]
    if not rows:
        return []

    header_cells = rows[0]
    headers = [clean_cell(cell_html) for _tag, cell_html in header_cells]
    has_header = any(tag == "th" for tag, _cell_html in header_cells)
    body_rows = rows[1:] if has_header else rows

    label_index = find_column(headers, ("日本語", "名称", "label", "name")) if has_header else 0
    prompt_index = find_column(headers, ("プロンプト", "prompt", "英語")) if has_header else None
    description_index = find_column(headers, ("解説", "説明", "description", "ひとこと")) if has_header else None

    items: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    for row in body_rows:
        if not row:
            continue

        if prompt_index is None or prompt_index >= len(row):
            prompt_candidates = [index for index, (_tag, cell) in enumerate(row) if CODE_RE.search(cell)]
            prompt_col = prompt_candidates[0] if prompt_candidates else (1 if len(row) > 1 else 0)
        else:
            prompt_col = prompt_index

        label_col = label_index if label_index is not None and label_index < len(row) else None
        if label_col is None or label_col == prompt_col:
            label_col = next((index for index in range(len(row)) if index != prompt_col), prompt_col)

        desc_col = (
            description_index
            if description_index is not None and description_index < len(row) and description_index != prompt_col
            else None
        )
        if desc_col is None:
            desc_col = next((index for index in range(len(row)) if index not in {label_col, prompt_col}), None)

        label = clean_cell(row[label_col][1]) if label_col is not None else ""
        prompt = prompt_from_cell(row[prompt_col][1])
        description = clean_cell(row[desc_col][1]) if desc_col is not None else ""

        if not prompt:
            continue
        if not label:
            label = prompt

        key = (label, prompt, description)
        if key in seen:
            continue
        seen.add(key)

        item = {"label": label, "prompt": prompt}
        if description:
            item["description"] = description
        items.append(item)

    return items


def iter_html_blocks(html_text: str):
    for match in BLOCK_RE.finditer(html_text):
        if match.group("figure") is not None:
            yield "figure", match.group("figure")
        else:
            yield match.group("tag").lower(), clean_text(match.group("head"))


def load_html_items(input_dir: Path) -> dict[str, dict[str, list[dict[str, str]]]]:
    grouped: dict[str, dict[str, list[dict[str, str]]]] = defaultdict(lambda: defaultdict(list))

    for html_path in sorted(input_dir.glob("*.html")):
        main_category: str | None = None
        sub_category: str | None = None

        html_text = html_path.read_text(encoding="utf-8", errors="replace")
        for kind, value in iter_html_blocks(html_text):
            if kind == "h2":
                main_category = value or html_path.stem
                sub_category = None
            elif kind == "h3":
                sub_category = value
            elif kind == "figure":
                if not main_category:
                    main_category = html_path.stem
                effective_sub = sub_category or main_category
                items = extract_table_items(value)
                if items:
                    grouped[main_category][effective_sub].extend(items)

    return grouped


def dedupe_items(items: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in items:
        key = (item.get("label", ""), item.get("prompt", ""), item.get("description", ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def write_data(grouped: dict[str, dict[str, list[dict[str, str]]]], output_dir: Path, clean: bool) -> tuple[int, int, int]:
    if clean and output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    category_count = 0
    subcategory_count = 0
    item_count = 0

    used_main_names: dict[str, str] = {}
    for main_category, subcategories in sorted(grouped.items()):
        main_dir_name = safe_dir_name(main_category, "main_category")
        if main_dir_name in used_main_names and used_main_names[main_dir_name] != main_category:
            main_dir_name = f"{main_dir_name}_{stable_suffix(main_category)}"
        used_main_names[main_dir_name] = main_category
        main_dir = output_dir / main_dir_name
        main_dir.mkdir(parents=True, exist_ok=True)
        category_count += 1

        used_sub_names: dict[str, str] = {}
        for sub_category, raw_items in sorted(subcategories.items()):
            items = dedupe_items(raw_items)
            if not items:
                continue

            sub_dir_name = safe_dir_name(sub_category, "sub_category")
            if sub_dir_name in used_sub_names and used_sub_names[sub_dir_name] != sub_category:
                sub_dir_name = f"{sub_dir_name}_{stable_suffix(sub_category)}"
            used_sub_names[sub_dir_name] = sub_category

            sub_dir = main_dir / sub_dir_name
            sub_dir.mkdir(parents=True, exist_ok=True)
            prompt_file = sub_dir / "prompt.json"
            prompt_file.write_text(
                json.dumps(items, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            subcategory_count += 1
            item_count += len(items)

    return category_count, subcategory_count, item_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import Scene prompt HTML files into ComfyUI prompt data JSON.")
    parser.add_argument("--input", type=Path, required=True, help="Directory containing source HTML files.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR, help="Destination data directory.")
    parser.add_argument("--clean", action="store_true", help="Delete the destination data directory before writing.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report counts without writing files.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.input.exists():
        raise SystemExit(f"Input directory does not exist: {args.input}")

    grouped = load_html_items(args.input)
    categories = len(grouped)
    subcategories = sum(len(subs) for subs in grouped.values())
    items = sum(len(dedupe_items(raw_items)) for subs in grouped.values() for raw_items in subs.values())

    print(f"parsed categories={categories} subcategories={subcategories} items={items}")
    if args.dry_run:
        return 0

    written_categories, written_subcategories, written_items = write_data(grouped, args.output, args.clean)
    print(
        "wrote "
        f"categories={written_categories} subcategories={written_subcategories} items={written_items} "
        f"to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
