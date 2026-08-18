#!/usr/bin/env python3

import argparse
import subprocess
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rebuild an image-heavy legacy PDF at web resolution."
    )
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("workdir", type=Path)
    parser.add_argument("--dpi", type=int, default=110)
    args = parser.parse_args()

    args.workdir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prefix = args.workdir / "page"

    subprocess.run(
        [
            "pdftoppm",
            "-jpeg",
            "-r",
            str(args.dpi),
            "-jpegopt",
            "quality=82,optimize=y,progressive=y",
            str(args.input),
            str(prefix),
        ],
        check=True,
    )

    source = PdfReader(str(args.input))
    images = sorted(args.workdir.glob("page-*.jpg"))
    if len(images) != len(source.pages):
        raise RuntimeError(
            f"Rendered {len(images)} images for {len(source.pages)} PDF pages."
        )

    first_box = source.pages[0].mediabox
    page_size = (float(first_box.width), float(first_box.height))
    document = canvas.Canvas(str(args.output), pagesize=page_size, pageCompression=1)
    document.setTitle(source.metadata.title or args.input.stem)
    for image in images:
        document.drawImage(
            ImageReader(str(image)),
            0,
            0,
            width=page_size[0],
            height=page_size[1],
            preserveAspectRatio=True,
            anchor="c",
        )
        document.showPage()
    document.save()

    rebuilt = PdfReader(str(args.output))
    if len(rebuilt.pages) != len(source.pages):
        raise RuntimeError("The rebuilt PDF page count does not match the source.")


if __name__ == "__main__":
    main()
