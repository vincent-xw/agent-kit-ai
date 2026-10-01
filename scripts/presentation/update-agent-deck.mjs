import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const sourcePptx = "/Users/xuewen/ai-lab/project/agent-kit/docs/shared/从对话到闭环：面向 Android 设备的 Agent 工程化实践.pptx";
const workspaceDir = process.env.AGENT_DECK_WORKSPACE ?? "/private/tmp/agent-deck-workspace";
const previewDir = path.join(workspaceDir, "slide5-architecture-preview");
const layoutDir = path.join(workspaceDir, "slide5-architecture-layout");

function shapeByName(slide, name) {
  const shape = slide.shapes.items.find((item) => item.name === name);
  if (!shape) throw new Error(`未找到形状：${name}`);
  return shape;
}

function existingShape(slide, name) {
  return slide.shapes.items.find((item) => item.name === name);
}

function styleText(shape, style) {
  shape.text.style = {
    typeface: "PingFang SC",
    autoFit: "shrinkText",
    wrap: "square",
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...style,
  };
}

function updateText(slide, name, text, position, style) {
  const shape = shapeByName(slide, name);
  shape.position = position;
  shape.text = text;
  styleText(shape, style);
  return shape;
}

function updatePanel(slide, name, position, fill) {
  const shape = shapeByName(slide, name);
  shape.position = position;
  shape.fill = fill;
  shape.line = { style: "solid", fill: "#C9D2DE", width: 1 };
  shape.borderRadius = 14;
  return shape;
}

function addBox(slide, { name, text, position, fill, line = "#B7D7E5", fontSize = 14, bold = false, color = "#111111" }) {
  const shape = existingShape(slide, name) ?? slide.shapes.add({
    geometry: "roundRect",
    name,
    position,
    fill,
    line: { style: "solid", fill: line, width: 1 },
    borderRadius: 10,
  });
  shape.position = position;
  shape.fill = fill;
  shape.line = { style: "solid", fill: line, width: 1 };
  shape.borderRadius = 10;
  shape.text = text;
  styleText(shape, { fontSize, bold, color, alignment: "center", verticalAlignment: "middle" });
  return shape;
}

function addText(slide, { name, text, position, fontSize = 14, bold = false, color = "#6B7280", alignment = "left" }) {
  const shape = existingShape(slide, name) ?? slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.position = position;
  shape.text = text;
  styleText(shape, { fontSize, bold, color, alignment, verticalAlignment: "middle" });
  return shape;
}

function addPanel(slide, { name, position, fill }) {
  const shape = existingShape(slide, name) ?? slide.shapes.add({
    geometry: "roundRect",
    name,
    position,
    fill,
    line: { style: "solid", fill: "#C9D2DE", width: 1 },
    borderRadius: 12,
  });
  shape.position = position;
  shape.fill = fill;
  shape.line = { style: "solid", fill: "#C9D2DE", width: 1 };
  shape.borderRadius = 12;
  return shape;
}

function connectOnce(slide, name, source, target, options) {
  const existing = existingShape(slide, name);
  if (existing) return existing;
  const connector = slide.shapes.connect(source, target, options);
  connector.name = name;
  return connector;
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function main() {
  const presentation = await PresentationFile.importPptx(await FileBlob.load(sourcePptx));
  const slides = presentation.slides.items;
  if (slides.length !== 20) throw new Error(`预期 20 页，实际 ${slides.length} 页`);
  const slide = slides[4];

  updateText(slide, "section-two-kicker", "03  /  架构", { left: 72, top: 56, width: 240, height: 28 }, {
    fontSize: 16,
    bold: true,
    color: "#3D8DFF",
    alignment: "left",
  });
  updateText(slide, "section-two-title", "Agent 工程架构：从输入到设备反馈的闭环", { left: 72, top: 104, width: 1136, height: 54 }, {
    fontSize: 38,
    bold: true,
    color: "#111111",
    alignment: "left",
  });
  updateText(slide, "section-two-lead", "BFF 负责边界，Harness 负责编排，工具负责把意图变成真实动作。", { left: 72, top: 196, width: 1136, height: 40 }, {
    fontSize: 19,
    color: "#6B7280",
    alignment: "left",
  });

  // 复用原有三条横向区域作为架构分区底板，保留该章节的白底视觉语言。
  updatePanel(slide, "section-two-UI 侧-panel", { left: 72, top: 318, width: 252, height: 194 }, "#F4F5F7");
  updatePanel(slide, "section-two-服务侧-panel", { left: 350, top: 294, width: 580, height: 254 }, "#E5F5FB");
  updatePanel(slide, "section-two-手机侧-panel", { left: 956, top: 318, width: 252, height: 194 }, "#F4F5F7");

  updateText(slide, "section-two-UI 侧-label", "交互层", { left: 94, top: 334, width: 190, height: 24 }, {
    fontSize: 17,
    bold: true,
    color: "#3D8DFF",
    alignment: "left",
  });
  updateText(slide, "section-two-UI 侧-title", "Web UI / 浏览器扩展", { left: 94, top: 368, width: 212, height: 30 }, {
    fontSize: 17,
    bold: true,
    color: "#111111",
    alignment: "left",
  });
  updateText(slide, "section-two-UI 侧-body", "输入 / 对话 / SSE 事件\n实时展示结果", { left: 94, top: 410, width: 212, height: 58 }, {
    fontSize: 14,
    color: "#6B7280",
    alignment: "left",
  });

  updateText(slide, "section-two-服务侧-label", "Agent 服务层", { left: 378, top: 308, width: 220, height: 24 }, {
    fontSize: 17,
    bold: true,
    color: "#3D8DFF",
    alignment: "left",
  });
  updateText(slide, "section-two-服务侧-title", "Hono BFF + Agent Runtime", { left: 378, top: 340, width: 330, height: 30 }, {
    fontSize: 20,
    bold: true,
    color: "#111111",
    alignment: "left",
  });
  updateText(slide, "section-two-服务侧-body", "鉴权边界 · session · 工具编排 · 状态回灌", { left: 378, top: 500, width: 500, height: 24 }, {
    fontSize: 13,
    color: "#6B7280",
    alignment: "left",
  });

  updateText(slide, "section-two-手机侧-label", "执行层", { left: 978, top: 334, width: 190, height: 24 }, {
    fontSize: 17,
    bold: true,
    color: "#3D8DFF",
    alignment: "left",
  });
  updateText(slide, "section-two-手机侧-title", "真实工具与环境", { left: 978, top: 368, width: 210, height: 30 }, {
    fontSize: 17,
    bold: true,
    color: "#111111",
    alignment: "left",
  });
  updateText(slide, "section-two-手机侧-body", "Android：ADB / UIAutomator\nFlutter VM / WebView CDP\nBrowser Tool Host（remote）", { left: 978, top: 408, width: 210, height: 78 }, {
    fontSize: 13,
    color: "#6B7280",
    alignment: "left",
  });

  // 中间 runtime 的三个关键节点：请求边界、循环编排、模型与上下文。
  const bff = addBox(slide, {
    name: "architecture-bff",
    text: "Hono BFF\n鉴权 / session namespace",
    position: { left: 378, top: 388, width: 150, height: 76 },
    fill: "#FFFFFF",
    fontSize: 13,
  });
  const harness = addBox(slide, {
    name: "architecture-harness",
    text: "AgentHarness\n模型 ↔ 工具循环",
    position: { left: 550, top: 388, width: 180, height: 76 },
    fill: "#3D8DFF",
    line: "#3D8DFF",
    fontSize: 15,
    bold: true,
    color: "#FFFFFF",
  });
  const model = addBox(slide, {
    name: "architecture-model",
    text: "LLM / Prompt / Context\nTool Registry + Zod",
    position: { left: 752, top: 388, width: 150, height: 76 },
    fill: "#FFFFFF",
    fontSize: 12,
  });

  // 连接线不是内容节点，重复执行时统一重建，避免旧线条与新线条叠加。
  for (const connector of slide.shapes.items.filter((item) => item.connector)) connector.delete();

  // 连接线使用明确的语义：请求进入、工具执行、结果回灌。
  connectOnce(slide, "architecture-harness-loop", bff, harness, {
    kind: "straight",
    fromSide: "right",
    toSide: "left",
    line: { style: "solid", fill: "#3D8DFF", width: 2 },
    tail: { type: "arrow", width: "sm", length: "sm" },
  });
  connectOnce(slide, "architecture-model-loop", harness, model, {
    kind: "straight",
    fromSide: "right",
    toSide: "left",
    line: { style: "solid", fill: "#3D8DFF", width: 2 },
    tail: { type: "arrow", width: "sm", length: "sm" },
  });

  const executionPanel = shapeByName(slide, "section-two-手机侧-panel");
  const toolLink = connectOnce(slide, "architecture-tool-call", model, executionPanel, {
    kind: "straight",
    fromSide: "right",
    toSide: "left",
    line: { style: "solid", fill: "#3D8DFF", width: 2 },
    tail: { type: "arrow", width: "med", length: "med" },
  });
  toolLink.bringToFront?.();
  const resultLink = connectOnce(slide, "architecture-tool-result", executionPanel, harness, {
    kind: "elbow",
    fromSide: "bottom",
    toSide: "bottom",
    line: { style: "dashed", fill: "#6B7280", width: 1.5 },
    tail: { type: "arrow", width: "sm", length: "sm" },
  });
  resultLink.bringToFront?.();
  const uiLink = connectOnce(slide, "architecture-request-and-sse", shapeByName(slide, "section-two-UI 侧-panel"), bff, {
    kind: "straight",
    fromSide: "right",
    toSide: "left",
    line: { style: "solid", fill: "#3D8DFF", width: 2 },
    head: { type: "arrow", width: "med", length: "med" },
    tail: { type: "arrow", width: "sm", length: "sm" },
  });

  addText(slide, {
    name: "architecture-request-label",
    text: "run / SSE",
    position: { left: 270, top: 370, width: 80, height: 20 },
    fontSize: 11,
    color: "#3D8DFF",
    alignment: "center",
  });
  addText(slide, {
    name: "architecture-tool-label",
    text: "server / remote tools",
    position: { left: 832, top: 354, width: 128, height: 22 },
    fontSize: 11,
    color: "#3D8DFF",
    alignment: "center",
  });
  addText(slide, {
    name: "architecture-result-label",
    text: "tool result 回灌",
    position: { left: 744, top: 464, width: 136, height: 22 },
    fontSize: 11,
    color: "#6B7280",
    alignment: "center",
  });

  const statePanel = addPanel(slide, {
    name: "architecture-state-security",
    position: { left: 72, top: 574, width: 1136, height: 54 },
    fill: "#F7FAFC",
  });
  const stateLabel = addText(slide, {
    name: "architecture-state-label",
    text: "状态与安全",
    position: { left: 94, top: 589, width: 128, height: 22 },
    fontSize: 16,
    bold: true,
    color: "#3D8DFF",
  });
  stateLabel.text.verticalAlignment = "middle";
  addText(slide, {
    name: "architecture-state-body",
    text: "SQLite / D1 Session · AES-GCM Secret · PendingCall · Audit",
    position: { left: 248, top: 588, width: 560, height: 24 },
    fontSize: 14,
    color: "#374151",
  });
  addText(slide, {
    name: "architecture-security-note",
    text: "前端不持有 LLM Key",
    position: { left: 890, top: 588, width: 286, height: 24 },
    fontSize: 13,
    bold: true,
    color: "#3D8DFF",
    alignment: "right",
  });

  // 让状态与安全底板位于架构节点之后，避免被连线遮挡，同时保持页码可见。
  statePanel.sendToBack?.();

  await fs.mkdir(previewDir, { recursive: true });
  await fs.mkdir(layoutDir, { recursive: true });
  for (let index = 0; index < slides.length; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    await writeBlob(path.join(previewDir, `slide-${number}.png`), await presentation.export({ slide: slides[index], format: "png", scale: 1 }));
    await fs.writeFile(path.join(layoutDir, `slide-${number}.layout.json`), await (await slides[index].export({ format: "layout" })).text(), "utf8");
  }

  const inspect = await presentation.inspect({ kind: "slide,textbox,shape,image,notes", max_chars: 240000 });
  await fs.writeFile(path.join(workspaceDir, "slide5-architecture-inspect.ndjson"), inspect.ndjson || "", "utf8");
  const output = await PresentationFile.exportPptx(presentation);
  await output.save(sourcePptx);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
