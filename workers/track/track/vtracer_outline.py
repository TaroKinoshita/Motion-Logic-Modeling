"""Convert a black silhouette on white to normalized Canvas path commands."""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import vtracer

svg = vtracer.convert_raw_image_to_svg(Path(sys.argv[1]).read_bytes(), img_format="png",
                                     colormode="binary", hierarchical="cutout", mode="spline", filter_speckle=2)
root = ET.fromstring(svg)
scale = float(root.attrib["width"]), float(root.attrib["height"])
number = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
commands = []
for path in root.findall("{*}path"):
    if path.get("fill") not in ("#000000", "#000"):
        continue
    transform = path.get("transform", "translate(0,0)")
    match = re.fullmatch(rf"translate\(\s*({number})[,\s]+({number})\s*\)", transform)
    if match is None:
        raise ValueError(f"Unsupported VTracer transform {transform}")
    shift = tuple(map(float, match.groups()))
    data = path.attrib["d"]
    parts = re.findall(rf"[A-DF-Za-df-z]|{number}", data)
    index = 0
    while index < len(parts):
        op = parts[index]
        count = {"M":2, "L":2, "C":6, "Z":0}[op]
        if count:
            points = [round((float(value)+shift[i%2])/scale[i%2], 6)
                      for i, value in enumerate(parts[index+1:index+1+count])]
            if len(points) != count:
                raise ValueError("Incomplete VTracer command")
            commands.append({"op":op, "p":points})
        else:
            commands.append({"op":op})
        index += count + 1
if not commands:
    raise ValueError("No black foreground to vectorize")
print(json.dumps(commands,separators=(",",":")))
