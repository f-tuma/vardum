import { SaxesParser } from "saxes";
import { CapacityError } from "./resource-budget.js";
import type { Transformation } from "./transformation.js";

// This is deliberately a passive geometric SVG dialect, not an SVG editor.
// The XML parser validates structure/namespaces; every emitted value is checked
// separately and escaped. Never pass rejected source markup to an SVG renderer.
export const svgInputByteLimit = 512 * 1024;
const namespace = "http://www.w3.org/2000/svg";
const idPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const numberSource = "[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?";
const numberPattern = new RegExp(`^${numberSource}$`);
const presentation = new Set(["id", "transform", "fill", "fill-rule", "clip-rule", "fill-opacity", "opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit"]);
const geometry: Record<string, readonly string[]> = {
  svg: ["width", "height", "viewBox", "preserveAspectRatio"], g: [], path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"], circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"], line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"], polygon: ["points"],
};
const colors = new Set(["none", "transparent", "black", "white", "red", "green", "blue", "yellow", "gray", "grey", "silver", "maroon", "purple", "fuchsia", "lime", "olive", "navy", "teal", "aqua", "orange"]);
type SvgNode = { name: string; attrs: Record<string, string>; children: SvgNode[] };

function rejected(reason: string): never {
  throw new CapacityError(`SVG derivative unavailable: ${reason}`, 422);
}

function numeric(value: string) {
  if (!numberPattern.test(value)) rejected("unsupported numeric value");
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > 10_000_000) rejected("numeric limit exceeded");
  return result;
}

function numbers(value: string) {
  const matcher = new RegExp(numberSource, "g");
  const values: number[] = [];
  let end = 0;
  for (const match of value.matchAll(matcher)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index))) rejected("invalid geometric value");
    values.push(numeric(match[0]));
    if (values.length > 32_768) rejected("geometric complexity limit exceeded");
    end = match.index + match[0].length;
  }
  if (!/^[\s,]*$/.test(value.slice(end))) rejected("invalid geometric value");
  return values;
}

function validatePath(value: string) {
  const matcher = new RegExp(`[MmZzLlHhVvCcSsQqTtAa]|${numberSource}`, "g");
  const arities: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let end = 0, count = 0, command = "", total = 0;
  let args: number[] = [];
  const finish = () => {
    if (!command) return;
    const arity = arities[command]!;
    if (arity ? count === 0 || count % arity !== 0 : count !== 0) rejected("invalid path parameters");
    if (command === "a") for (let offset = 0; offset < args.length; offset += 7) {
      if (args[offset]! < 0 || args[offset + 1]! < 0 || ![0, 1].includes(args[offset + 3]!) || ![0, 1].includes(args[offset + 4]!))
        rejected("invalid arc parameters");
    }
  };
  for (const match of value.matchAll(matcher)) {
    if (!/^[\s,]*$/.test(value.slice(end, match.index))) rejected("invalid path data");
    const token = match[0];
    if (/^[A-Za-z]$/.test(token)) {
      finish();
      if (!command && token.toLowerCase() !== "m") rejected("path must begin with moveto");
      command = token.toLowerCase(); count = 0; args = [];
    } else {
      if (!command || command === "z") rejected("invalid path data");
      args.push(numeric(token)); count++;
      if (++total > 32_768) rejected("path complexity limit exceeded");
    }
    end = match.index + token.length;
  }
  if (!command || !/^[\s,]*$/.test(value.slice(end))) rejected("invalid path data");
  finish();
}

function validateTransform(value: string) {
  // Sticky matching makes invalid long names linear too: an unanchored global
  // search would retry its greedy name scan at every subsequent character.
  const matcher = /([A-Za-z]+)\s*\(([^()]*)\)/y;
  const arities: Record<string, readonly number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
  let end = 0, count = 0;
  while (end < value.length) {
    const separator = /^[\s,]*/.exec(value.slice(end))![0];
    end += separator.length;
    if (end === value.length) break;
    matcher.lastIndex = end;
    const match = matcher.exec(value);
    if (!match || !Object.hasOwn(arities, match[1]!) || !arities[match[1]!]!.includes(numbers(match[2]!).length))
      rejected("unsupported transform");
    if (++count > 32) rejected("transform complexity limit exceeded");
    end = matcher.lastIndex;
  }
  if (!count) rejected("unsupported transform");
}

function validateAttribute(name: string, value: string) {
  if (name === "id") { if (!idPattern.test(value)) rejected("unsupported XML ID"); return; }
  if (name === "transform") return validateTransform(value);
  if (name === "d") return validatePath(value);
  if (name === "viewBox") {
    const values = numbers(value);
    if (values.length !== 4 || values[2]! <= 0 || values[3]! <= 0) rejected("invalid viewBox");
    return;
  }
  if (name === "points") { const values = numbers(value); if (values.length < 4 || values.length % 2) rejected("invalid points"); return; }
  if (name === "fill" || name === "stroke") {
    if (!colors.has(value) && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) rejected("unsupported paint");
    return;
  }
  if (name === "fill-rule" || name === "clip-rule") { if (!["nonzero", "evenodd"].includes(value)) rejected("unsupported fill rule"); return; }
  if (name === "stroke-linecap") { if (!["butt", "round", "square"].includes(value)) rejected("unsupported stroke linecap"); return; }
  if (name === "stroke-linejoin") { if (!["miter", "round", "bevel"].includes(value)) rejected("unsupported stroke linejoin"); return; }
  if (name === "preserveAspectRatio") { if (value !== "xMidYMid meet") rejected("unsupported aspect ratio"); return; }
  const number = numeric(value);
  if ((name.endsWith("opacity") && (number < 0 || number > 1)) ||
      (["width", "height", "r", "rx", "ry", "stroke-width", "stroke-miterlimit"].includes(name) && number < 0))
    rejected("invalid geometric value");
}

function parseSvg(bytes: Buffer) {
  if (bytes.length > svgInputByteLimit) rejected("source byte limit exceeded");
  let xml: string;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { rejected("only UTF-8 sources are supported"); }
  const parser = new SaxesParser({ xmlns: true });
  let root: SvgNode | undefined, count = 0;
  const stack: SvgNode[] = [];
  const ids = new Set<string>();
  parser.on("error", () => rejected("malformed XML"));
  parser.on("doctype", () => rejected("document types are unsupported"));
  parser.on("processinginstruction", () => rejected("processing instructions are unsupported"));
  parser.on("cdata", () => rejected("CDATA is unsupported"));
  parser.on("text", value => { if (value.trim()) rejected("text is unsupported"); });
  parser.on("xmldecl", declaration => {
    if (declaration.version !== "1.0" || (declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8")) rejected("unsupported XML declaration");
  });
  parser.on("opentag", tag => {
    if (tag.uri !== namespace || tag.prefix || !Object.hasOwn(geometry, tag.local) ||
        (stack.length === 0 ? Boolean(root) || tag.local !== "svg" : tag.local === "svg")) rejected("unsupported element or namespace");
    if (++count > 2048 || stack.length >= 32) rejected("document complexity limit exceeded");
    if (Object.keys(tag.attributes).length > 24) rejected("attribute limit exceeded");
    const node: SvgNode = { name: tag.local, attrs: {}, children: [] };
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.name === "xmlns" && !stack.length && attribute.value === namespace) continue;
      if (attribute.uri || attribute.prefix || !(presentation.has(attribute.name) || geometry[node.name]!.includes(attribute.name))) rejected("unsupported attribute");
      if (attribute.value.length > 128 * 1024) rejected("attribute byte limit exceeded");
      validateAttribute(attribute.name, attribute.value);
      node.attrs[attribute.name] = attribute.value;
    }
    if (node.attrs.id) {
      if (ids.has(node.attrs.id)) rejected("duplicate XML ID");
      ids.add(node.attrs.id);
    }
    const parent = stack.at(-1);
    if (parent) {
      if (parent.name !== "svg" && parent.name !== "g") rejected("geometry cannot contain elements");
      parent.children.push(node);
    } else root = node;
    stack.push(node);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  if (!root) rejected("empty document");
  return root;
}

function selected(root: SvgNode, id: string): SvgNode | null {
  if (root.attrs.id === id) {
    if (root.name !== "g") rejected("layer selection requires a group ID");
    return root;
  }
  for (const child of root.children) {
    const descendant = selected(child, id);
    if (descendant) return { ...root, children: [descendant] };
  }
  return null;
}

function adaptive(root: SvgNode, id: string, within = false, inheritedFill = "black"): boolean {
  const active = within || root.attrs.id === id;
  if (root.attrs.id === id && root.name !== "g") rejected("adaptive color requires a group ID");
  const fill = root.attrs.fill ?? inheritedFill;
  if (active && root.name !== "g" && root.name !== "svg" && fill !== "none") root.attrs.class = "vard-adaptive-fill";
  let found = root.attrs.id === id;
  for (const child of root.children) found = adaptive(child, id, active, fill) || found;
  return found;
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function serialize(root: SvgNode): string {
  const attributes = Object.entries(root.attrs).map(([name, value]) => ` ${name}="${escape(value)}"`).join("");
  return `<${root.name}${attributes}>${root.children.map(serialize).join("")}</${root.name}>`;
}

/** No rasterization: preserve the source canvas, ancestor transforms and colors. */
export function renderSvg(bytes: Buffer, transformation: Transformation, maxOutputPixels: number) {
  if (transformation.bg && !/^#[0-9a-fA-F]{6}$/.test(transformation.bg)) rejected("unsupported background");
  if (transformation.darkLayer && (!transformation.darkColor || !/^#[0-9a-fA-F]{6}$/.test(transformation.darkColor))) rejected("unsupported adaptive color");
  let root = parseSvg(bytes);
  const viewBox = root.attrs.viewBox ? numbers(root.attrs.viewBox) : null;
  const sourceWidth = root.attrs.width ? numeric(root.attrs.width) : viewBox?.[2];
  const sourceHeight = root.attrs.height ? numeric(root.attrs.height) : viewBox?.[3];
  if (!sourceWidth || !sourceHeight || sourceWidth > 16_384 || sourceHeight > 16_384 || sourceWidth * sourceHeight > 100_000_000) rejected("source canvas limit exceeded");
  if (transformation.layer) {
    const layer = selected(root, transformation.layer);
    if (!layer) rejected("selected group was not found");
    root = layer;
  }
  if (transformation.darkLayer && !adaptive(root, transformation.darkLayer)) rejected("adaptive group was not found in the selected output");
  const width = transformation.w ?? (transformation.h ? Math.max(1, Math.round(transformation.h * sourceWidth / sourceHeight)) : sourceWidth);
  const height = transformation.h ?? (transformation.w ? Math.max(1, Math.round(transformation.w * sourceHeight / sourceWidth)) : sourceHeight);
  if (!Number.isFinite(width * height) || width > 16_384 || height > 16_384 || width * height > maxOutputPixels) rejected("output canvas limit exceeded");
  const inset = Math.floor(Math.min(width, height) * (transformation.pad ?? 0) / 100);
  // The source viewport and its viewBox can have different aspect ratios.
  // Keep that mapping intact, then contain the complete native canvas in a
  // separate viewport. Resizing the source viewport itself would lose its
  // existing letterboxing and change artwork scale/registration.
  const sourceCanvas: SvgNode = { ...root, attrs: {
    ...root.attrs, width: String(sourceWidth), height: String(sourceHeight),
    viewBox: root.attrs.viewBox ?? `0 0 ${sourceWidth} ${sourceHeight}`,
  } };
  const contained: SvgNode = { name: "svg", attrs: {
    x: String(inset), y: String(inset),
    width: String(width - inset * 2), height: String(height - inset * 2),
    viewBox: `0 0 ${sourceWidth} ${sourceHeight}`, preserveAspectRatio: "xMidYMid meet",
  }, children: [sourceCanvas] };
  const background = transformation.bg ? `<rect width="${width}" height="${height}" fill="${transformation.bg}"/>` : "";
  const style = transformation.darkLayer ? `<style>@media (prefers-color-scheme: dark){.vard-adaptive-fill{fill:${transformation.darkColor}!important}}</style>` : "";
  const result = Buffer.from(`<svg xmlns="${namespace}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}${style}${serialize(contained)}</svg>`);
  if (result.length > 1024 * 1024) rejected("output byte limit exceeded");
  return result;
}

/** SVG-only options must fail before cache lookup, even after a source changes. */
export function svgSourceIssue(mimeType: string, transformation: Transformation) {
  if (transformation.render === "v2" && (!transformation.bg || !transformation.format || transformation.format === "svg"))
    return "Render v2 requires a raster output format and background";
  if (transformation.render === "v2" && mimeType !== "image/svg+xml")
    return "Render v2 requires an SVG source";
  return (transformation.format === "svg" || transformation.layer || transformation.darkLayer || transformation.darkColor) && mimeType !== "image/svg+xml"
    ? "SVG output and layer selection require an SVG source" : null;
}
