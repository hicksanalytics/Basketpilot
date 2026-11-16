"""Read fictional receipt images with Tesseract and verify the BasketPilot parser."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
LINES = [
    "COSTCO WHOLESALE",
    "Brentwood #386",
    "98 Seaboard Ln",
    "Brentwood TN 37027",
    "",
    "2 @ 4.25 E 782796 WATER 8.50 A",
    "E 1068080 ORGANIC EGGS 9.50",
    "",
    "SUBTOTAL 18.00",
    "TAX 0.00",
    "TOTAL 18.00",
    "11/14/2026",
    "Whse:386 Trm:7 Trn:32 OP:113",
]
PARSE = """
const fs = require('node:fs');
const { parseReceipt } = require(process.argv[1]);
process.stdout.write(JSON.stringify(parseReceipt(fs.readFileSync(0, 'utf8'))));
"""


def main():
    args_parser = argparse.ArgumentParser(description=__doc__)
    args_parser.add_argument("--font", default="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")
    args = args_parser.parse_args()
    paper = Image.new("L", (1024, 700), color=255)
    drawer = ImageDraw.Draw(paper)
    font = ImageFont.truetype(args.font, size=32)
    for index, line in enumerate(LINES):
        drawer.text((64, 40 + 46 * index), line, font=font, fill=15)

    with tempfile.TemporaryDirectory(prefix="basketpilot-ocr-") as directory:
        for angle in (0, 1):
            image = Path(directory) / f"receipt-{angle}.png"
            paper.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=255).save(image)
            extracted = subprocess.run(
                ["tesseract", str(image), "stdout", "-l", "eng", "--oem", "1", "--psm", "6"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            output = subprocess.run(
                ["node", "-e", PARSE, str(ROOT / "public" / "receipt-parser.js")],
                check=True,
                capture_output=True,
                input=extracted,
                text=True,
            ).stdout
            receipt = json.loads(output)
            assert receipt["retailer"] == "costco", extracted
            assert receipt["storeId"] == "386", extracted
            assert receipt["purchasedOn"] == "2026-11-14", extracted
            assert receipt["subtotalDelta"] == 0, extracted
            assert [
                (item["sku"], item["quantity"], item["lineTotal"], item["unitPrice"])
                for item in receipt["items"]
            ] == [
                ("782796", 2, 8.50, 4.25),
                ("1068080", 1, 9.50, 9.50),
            ], extracted
            print(f"PASS: fictional Costco receipt at {angle} degrees")


if __name__ == "__main__":
    main()
