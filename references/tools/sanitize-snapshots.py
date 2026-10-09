#!/usr/bin/env python3
"""
Extract sanitised DOM snapshots from a raw Khan Academy page capture.

Raw captures are large (500 KB+) and contain experiment-bucketing hashes
(`kaid`), an inline `__KA_DATA__` application state blob, and other page data
that this project has no business keeping. This script keeps only the small,
structural excerpts that the selector adapter was actually designed from, and
redacts identifier-shaped values.

Usage:
    sanitize-snapshots.py <raw.html> <outDir> <label>

Writes:
    <outDir>/<label>-question-region.html
    <outDir>/<label>-exercise-footer.html
    <outDir>/<label>-feedback-dialog.html
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from lxml import html as lxml_html

# Attributes worth keeping: they are the contract the adapter relies on.
KEEP_ATTRS = {
    "class",
    "name",
    "role",
    "type",
    "data-testid",
    "data-perseus-paragraph-index",
    "data-exercise-id",
    "aria-label",
    "aria-hidden",
    "aria-disabled",
    "aria-required",
    "aria-invalid",
    "aria-checked",
    "aria-valuenow",
    "disabled",
    "placeholder",
}

# Never emit these, whatever they contain.
DROP_TAGS = {"script", "style", "noscript", "iframe"}

# Identifier-shaped content to redact.
REDACTIONS = [
    (re.compile(r"\b[0-9a-f]{64}\b", re.I), "<redacted-hash>"),
    (re.compile(r"\b[0-9a-f]{32}\b", re.I), "<redacted-id>"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<redacted-email>"),
]


def sanitize_text(value: str) -> str:
    for pattern, replacement in REDACTIONS:
        value = pattern.sub(replacement, value)
    return value


def clean(node) -> None:
    """Recursively strip disallowed tags and attributes from a subtree."""
    for element in list(node.iter()):
        if not isinstance(element.tag, str):
            continue
        if element.tag.lower() in DROP_TAGS:
            element.getparent().remove(element)
            continue
        for attr in list(element.attrib):
            if attr.lower() not in KEEP_ATTRS:
                del element.attrib[attr]
            else:
                element.set(attr, sanitize_text(element.get(attr) or ""))
        if element.text:
            element.text = sanitize_text(element.text)
        if element.tail:
            element.tail = sanitize_text(element.tail)


def render(node, comment: str) -> str:
    from lxml import etree

    body = etree.tostring(node, pretty_print=True, encoding="unicode")
    return f"<!-- {comment} -->\n{body}"


def first(doc, xpath: str):
    found = doc.xpath(xpath)
    return found[0] if found else None


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    raw_path, out_dir, label = sys.argv[1], sys.argv[2], sys.argv[3]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    doc = lxml_html.parse(raw_path).getroot()
    written = []

    # 1. The question region: the element the adapter fingerprints.
    region = first(doc, '//form[@name="answerform"]')
    if region is not None:
        clone = lxml_html.fromstring(lxml_html.tostring(region))
        clean(clone)
        target = out / f"{label}-question-region.html"
        target.write_text(
            render(
                clone,
                "Sanitised excerpt: the QUESTION REGION. This whole subtree is what the "
                "detector fingerprints. Note it contains only the stem and the answer "
                "widget - no feedback, no hints.",
            ),
            encoding="utf-8",
        )
        written.append(target)

    # 2. The footer: holds the progress marker and the controls.
    footer = first(doc, '//*[@data-testid="content-library-footer"]')
    if footer is not None:
        clone = lxml_html.fromstring(lxml_html.tostring(footer))
        clean(clone)
        target = out / f"{label}-exercise-footer.html"
        target.write_text(
            render(
                clone,
                "Sanitised excerpt: the EXERCISE FOOTER. The progress cells "
                "(data-testid='exercise-progress-<index>-<state>[-current]') and the "
                "check / skip / start-over controls live here, OUTSIDE the question "
                "region.",
            ),
            encoding="utf-8",
        )
        written.append(target)

    # 3. Feedback dialogs, which render outside the question region.
    dialogs = [
        d
        for d in doc.xpath('//*[@role="dialog"]')
        if not re.search(r"cookie|privacy", d.text_content() or "", re.I)
    ]
    if dialogs:
        from lxml import etree

        parts = [
            "<!-- Sanitised excerpt: FEEDBACK dialog(s). These are SIBLINGS of the "
            "question region, not descendants, which is why a correct/incorrect "
            "verdict never disturbs the question fingerprint. -->"
        ]
        for i, dialog in enumerate(dialogs):
            clone = lxml_html.fromstring(lxml_html.tostring(dialog))
            clean(clone)
            parts.append(f"<!-- dialog {i + 1} -->")
            parts.append(etree.tostring(clone, pretty_print=True, encoding="unicode"))
        target = out / f"{label}-feedback-dialog.html"
        target.write_text("\n".join(parts), encoding="utf-8")
        written.append(target)

    for path in written:
        print(f"wrote {path}  ({path.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
