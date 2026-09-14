export const TASK_SURFACE_SCRIPT = `
import { node, clear } from "/assets/js/dom.js";
import { anchorSection, sectionHead, richText, inputCard, roleCard, runCard, pill } from "/assets/js/components.js";

// All business facts below retain their Context reference. Expanded values
// are current reads, not mutations of a historical Context snapshot.
export function renderTaskSurface(container, data, t, locale, actions) {
  clear(container);
  const core = data.core;
  const task = data.task;
  container.dataset.taskId = task.id;
  const zh = locale.startsWith("zh");
  const say = (en, cn) => zh ? cn : en;
  const records = (store) => core.records.filter((entry) => entry.ref.store === store);
  const values = (store) => records(store).filter((entry) => !entry.omitted).map((entry) => entry.value);
  const scaffold = node("div", "detail-scaffold task-surface");
  const summary = node("div", "section-body");
  summary.append(node("span", "detail-kicker", task.id), node("h2", "detail-title", task.title), pill(t, "status", task.status));
  const conversation = node("button", "record-open", say("View Leader Session (read-only)", "查看 Leader Session（只读）"));
  conversation.type = "button";
  // A Draft's planning Session is a real Leader Session, so it is viewable once it
  // actually exists. The button is disabled only when there is no Session to show
  // — not because the Task has yet to be activated. The Session lives in the
  // runtime observation, which arrives separately from the Context snapshot.
  const leaderRole = (data.runtime?.roles ?? []).find((role) => role.name === "leader") ?? null;
  const hasLeaderSession = Boolean(leaderRole?.runtimeSession?.nativeSessionId);
  conversation.disabled = task.status === "archived" || !hasLeaderSession;
  conversation.addEventListener("click", () => actions.openTerminal({ scope: "task", taskId: task.id, roleName: "leader" }));
  summary.append(conversation);
  const chat = node("form", "record-card");
  const chatLabel = node("label", "", say("Message to Task Leader", "发送给 Task Leader"));
  const message = node("textarea", "");
  message.required = true;
  message.maxLength = 8000;
  chatLabel.append(message);
  // Submission intent is an explicit user choice, never inferred from the body
  // (task-32 §2.5); discuss is the default so the control matches the service.
  const intentLabel = node("label", "", say("Intent", "提交意图"));
  const intentSelect = node("select", "");
  const intentOptions = [
    ["discuss", say("Discuss — route to planning", "讨论 — 进入规划")],
    ["record", say("Record — save only", "记录 — 仅保存")],
    ["develop", say("Develop — request activation", "开发 — 请求激活")]
  ];
  for (const [value, text] of intentOptions) {
    const option = node("option", "", text);
    option.value = value;
    intentSelect.append(option);
  }
  intentSelect.value = "discuss";
  intentLabel.append(intentSelect);
  chat.addEventListener("input", () => { chat.dataset.unsent = message.value ? "true" : "false"; });
  const send = node("button", "record-open", say("Send", "发送"));
  send.type = "submit";
  send.disabled = !["active", "draft"].includes(task.status);
  const sent = node("p", "muted", say("Not submitted", "未提交"));
  sent.setAttribute("role", "status");
  // §2.5 facets render here, one per line; cleared and repopulated on every submit.
  const facets = node("div", "section-body");
  facets.dataset.submissionFacets = "";
  chat.append(chatLabel, intentLabel, send, sent, facets);
  chat.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (send.disabled) return;
    send.disabled = true;
    chat.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    const intent = intentSelect.value;
    clear(facets);
    sent.textContent = say("Waiting for receipt · ", "等待回执 · ") + requestId;
    try {
      // requestId is the submission key: the same key retried returns the original
      // Message and routing rather than a second submission (task-32 §2.3).
      const receipt = await actions.sendMessage(task.id, message.value, requestId, intent);
      sent.textContent = say("Saved · ", "已保存 · ") + receipt.record.id;
      renderSubmissionFacets(facets, receipt.submission, say);
      message.value = "";
      chat.dataset.unsent = "false";
      send.disabled = false;
    } catch (error) {
      if (error.disposition === "not-submitted") {
        sent.textContent = say("Not submitted: ", "未提交：") + error.message;
        send.disabled = false;
        return;
      }
      // A lost response must never auto-replay a write; the same requestId is safe
      // to resend by hand because the server dedups on it (§2.3), but the user
      // reloads and inspects first rather than blindly resending.
      sent.textContent = say("Unknown submission outcome. Reload and inspect saved messages before sending again · ",
        "提交结果未知。请重新加载并检查已保存消息，不要盲目重发 · ") + requestId;
    }
  });
  summary.append(chat);
  // decision-3 three-action input control (queue / steer / interrupt). This is
  // the same application-layer path the CLI drives; the Web surface adds no
  // fourth action and no auto-fallback. Steer/interrupt name an exact current
  // Turn (expected-target); a mismatch or missing Turn is a visible failure
  // receipt, never a silent downgrade to a queue.
  const control = node("details", "record-card");
  control.append(node("summary", "", say("Redirect a running Role (queue / steer / interrupt)",
    "改向运行中的 Role（排队／即时插话／打断）")));
  const controlForm = node("form", "record-block");
  const actionLabel = node("label", "", say("Action", "动作"));
  const action = node("select", "");
  for (const [val, en, cn] of [["queue", "Queue (deliver at next opportunity)", "排队（下次机会送达）"],
    ["steer", "Steer (inject into the exact current Turn)", "即时插话（注入当前 Turn）"],
    ["interrupt", "Interrupt (native cancel of the current Turn)", "打断（原生取消当前 Turn）"]]) {
    const opt = node("option", "", say(en, cn));
    opt.value = val;
    action.append(opt);
  }
  actionLabel.append(action);
  const roleLabel = node("label", "", say("Target Role", "目标 Role"));
  const role = node("input", "");
  role.placeholder = say("e.g. worker (blank = Leader for queue)", "如 worker（排队留空 = Leader）");
  roleLabel.append(role);
  const bodyLabel = node("label", "", say("Message", "消息内容"));
  const body = node("textarea", "");
  body.maxLength = 8000;
  bodyLabel.append(body);
  const targetLabel = node("label", "", say("Expected current Turn", "预期当前 Turn"));
  const expectedTarget = node("input", "");
  expectedTarget.placeholder = say("exact current Turn id (attempt/native)", "当前 Turn 的精确标识");
  targetLabel.append(expectedTarget);
  const workItemLabel = node("label", "", say("Work Item (optional)", "Work Item（可选）"));
  const workItem = node("input", "");
  workItemLabel.append(workItem);
  const thenLabel = node("label", "", say("Then-message ref (optional)", "打断后续消息引用（可选）"));
  const thenMessage = node("input", "");
  thenMessage.placeholder = say("task/message id already saved", "已保存的 task/message 引用");
  thenLabel.append(thenMessage);
  const controlSend = node("button", "record-open", say("Submit control", "提交控制"));
  controlSend.type = "submit";
  controlSend.disabled = !["active", "draft"].includes(task.status);
  const controlSent = node("p", "muted", say("Not submitted", "未提交"));
  controlSent.setAttribute("role", "status");
  // Field visibility follows the selected action so the form can only submit a
  // legal shape: interrupt carries no body; queue needs no expected-target;
  // then-message is an interrupt-only continuation.
  const applyAction = () => {
    const kind = action.value;
    bodyLabel.hidden = kind === "interrupt";
    targetLabel.hidden = kind === "queue";
    thenLabel.hidden = kind !== "interrupt";
    roleLabel.hidden = false;
    role.required = kind !== "queue";
    body.required = kind !== "interrupt";
    expectedTarget.required = kind !== "queue";
  };
  action.addEventListener("change", applyAction);
  applyAction();
  controlForm.addEventListener("input", () => { controlForm.dataset.unsent = "true"; });
  controlForm.append(actionLabel, roleLabel, bodyLabel, targetLabel, workItemLabel, thenLabel, controlSend, controlSent);
  controlForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (controlSend.disabled) return;
    controlSend.disabled = true;
    controlForm.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    const kind = action.value;
    const payload = { action: kind, requestId };
    if (kind === "interrupt") {
      payload.role = role.value.trim();
      payload.expectedTarget = expectedTarget.value.trim();
      if (thenMessage.value.trim()) payload.thenMessage = thenMessage.value.trim();
    } else {
      payload.body = body.value;
      if (kind === "steer") { payload.to = role.value.trim(); payload.expectedTarget = expectedTarget.value.trim(); }
      else if (role.value.trim()) payload.to = role.value.trim();
      if (workItem.value.trim()) payload.workItem = workItem.value.trim();
    }
    controlSent.textContent = say("Waiting for receipt · ", "等待回执 · ") + requestId;
    try {
      const receipt = await actions.controlInput(task.id, payload, requestId);
      // The receipt states exactly what settled: a live steer/interrupt names its
      // Host outcome; a queue or a not-delivered/idempotent result names its own
      // state. None of these implies the Provider executed the input.
      const settled = receipt.steer || receipt.interrupt || receipt.delivery
        || { state: receipt.disposition };
      const outcome = settled.outcome ? " · outcome " + settled.outcome : "";
      const detail = settled.detail ? " · " + settled.detail : "";
      controlSent.textContent = say("Receipt: ", "回执：") + receipt.action + " · " + settled.state
        + outcome + detail + (receipt.record ? " · " + receipt.record.id : "");
      controlForm.dataset.unsent = "false";
      controlSend.disabled = false;
    } catch (error) {
      if (error.disposition === "not-submitted") {
        controlSent.textContent = say("Not submitted: ", "未提交：") + error.message;
        controlSend.disabled = false;
        return;
      }
      // A committed input whose live edge is delivery-unknown must not be
      // blindly re-sent under a new requestId or a different action.
      controlSent.textContent = say("Unknown outcome. Re-read the Session before acting; do not resend · ",
        "结果未知。请先重新读取 Session，不要盲目重发 · ") + requestId;
    }
  });
  control.append(controlForm);
  summary.append(control);
  // A Draft's Leader conversation IS its planning Turn, so this entry point does
  // reach a Leader. Report the real planning facts the snapshot carries — Turn,
  // Session, environment and the time they were observed — instead of asserting
  // that no runtime exists. When nothing has been dispatched yet, say exactly
  // that rather than implying the entry point is inert.
  if (task.status === "draft") {
    // Planning facts come from the Context snapshot, which is the authoritative
    // durable read and the one that drives re-rendering. The runtime observation
    // is explicitly optional (it may time out and only ever enriches a live
    // Session), so it must not decide whether a planning Turn is reported.
    const turnEntries = records("turn");
    const planningTurns = values("turn").filter((turn) =>
      turn.roleName === "leader" && turn.purpose === "planning");
    // The latest planning Turn, whatever state it reached. A completed planning
    // Turn is still the real observed fact; reporting only active ones would call
    // a Draft that has genuinely talked to its Leader "not dispatched".
    const planningTurn = planningTurns[planningTurns.length - 1] ?? null;
    // A bounded snapshot may withhold Turn values. That is not evidence that no
    // Turn exists, so it is reported as withheld rather than as "not dispatched".
    const withheldTurns = planningTurn === null && turnEntries.some((entry) => entry.omitted);
    const environment = planningTurn?.effective?.executionEnvironment ?? null;
    const liveLeader = (data.runtime?.roles ?? []).find((role) => role.name === "leader") ?? null;
    const planning = node("div", "record-card");
    planning.dataset.planning = planningTurn !== null
      ? planningTurn.status
      : withheldTurns ? "withheld" : "not-dispatched";
    planning.append(node("p", "muted", withheldTurns
      ? say("This bounded snapshot withholds Turn detail; read the Turn directly to see planning state.",
        "当前受限快照未展开 Turn 详情；请直接读取 Turn 查看规划状态。")
      : planningTurn === null
      ? say("No planning Turn has been dispatched yet. Sending a message queues the Leader.",
        "尚未派发 planning Turn；发送消息会为 Leader 排队。")
      : planningTurn.status === "active"
      ? say("Planning Turn is active; messages reach the Task Leader.",
        "planning Turn 正在进行；消息会送达 Task Leader。")
      : say("Planning Turn reached " + planningTurn.status
        + "; messages reach the same Task Leader and queue the next Turn.",
        "planning Turn 已" + planningTurn.status + "；消息仍送达同一 Task Leader 并为下一个 Turn 排队。")));
    const facts = [
      [say("Planning Turn", "planning Turn"), planningTurn
        ? planningTurn.id + " (" + planningTurn.status + ")"
        : withheldTurns ? say("withheld by this snapshot", "本快照未展开") : say("none", "无")],
      [say("Provider terminal", "Provider 终态"),
        planningTurn?.result?.provider?.status ?? say("not reported", "未上报")],
      // The Provider conversation is the durable transport identity of the
      // Session this Turn actually ran on; the live Session, when observed,
      // is reported separately so a stale read is never dressed up as current.
      [say("Provider conversation", "Provider 会话"),
        planningTurn?.result?.provider?.conversationId ?? say("not reported", "未上报")],
      [say("Live Leader Session", "在线 Leader Session"),
        liveLeader?.runtimeSession?.nativeSessionId
          ?? say("not currently running", "当前未在运行")],
      [say("Environment", "环境"), environment?.environmentRef
        ?? say("empty (legal for planning)", "空环境（规划阶段合法）")],
      [say("Turn observed at", "Turn 观测时间"),
        planningTurn?.result?.completedAt ?? planningTurn?.updatedAt ?? say("unknown", "未知")]
    ];
    for (const [label, value] of facts) {
      planning.append(node("p", "muted", label + ": " + value));
    }
    summary.append(planning);
  }
  if (task.description) summary.append(richText(say("Current requirements", "当前要求"), task.description, t));
  if (task.completionSummary) summary.append(richText(t("detail.conclusion"), task.completionSummary, t));
  const edit = node("details", "record-card");
  edit.append(node("summary", "", say("Edit Task title", "修改任务标题")));
  const form = node("form", "record-block");
  const label = node("label", "", say("Title", "标题"));
  const title = node("input", "");
  title.value = task.title;
  title.required = true;
  title.disabled = task.status === "archived";
  title.maxLength = 500;
  label.append(title);
  form.addEventListener("input", () => { form.dataset.unsent = "true"; });
  const save = node("button", "record-open", say("Save", "保存"));
  save.type = "submit";
  save.disabled = task.status === "archived";
  const feedback = node("p", "muted", say("Not submitted", "未提交"));
  feedback.setAttribute("role", "status");
  form.append(label, save, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    form.dataset.unsent = "true";
    const requestId = crypto.randomUUID();
    feedback.textContent = say("Waiting for save receipt · ", "正在等待保存回执 · ") + requestId;
    try {
      const receipt = await actions.updateTask(task.id, { title: title.value }, requestId);
      feedback.textContent = say("Saved · revision ", "已保存 · revision ") + receipt.revision;
      title.value = receipt.record.title;
      form.dataset.unsent = "false";
      save.disabled = false;
    } catch (error) {
      if (error.disposition === "not-submitted") {
        feedback.textContent = say("Not saved: ", "未保存：") + error.message;
        save.disabled = false;
        return;
      }
      // Local mutation IDs correlate requests; they are not a deduplication
      // ledger. A lost response must never automatically replay a write.
      feedback.textContent = say("Unknown save outcome. Reload this page to read current facts before submitting again. Request: ",
        "保存结果未知。请重新加载页面读取当前事实，再决定是否提交。请求：") + requestId;
    }
  });
  edit.append(form);
  summary.append(edit);
  scaffold.append(anchorSection("detail-top", sectionHead(t("tabs.summary")), summary));

  function recordCard(entry) {
    const card = node("article", "record-card");
    card.append(node("strong", "", entry.ref.store + " · " + entry.ref.refId));
    const ref = node("small", "muted", say("Revision: ", "版本：") + entry.ref.revision);
    card.append(ref);
    if (!entry.omitted) {
      const value = entry.value;
      const text = value.content || value.summary || value.body || value.objective || value.title || value.leaderSummary;
      if (text) card.append(richText(null, text, t));
      if (value.status) card.append(node("p", "muted", value.status));
      if (value.roleName) card.append(node("p", "muted", value.roleName));
      if (entry.ref.store === "work-item") {
        card.append(node("p", "muted", say("Owner: ", "负责人：") + (value.assignee || "Leader")));
        if (value.acceptance) card.append(richText(say("Acceptance criteria", "验收标准"), value.acceptance.join("\\n"), t));
      }
      if (entry.ref.store === "job") {
        const status = value.status;
        const label = status === "queued" ? say("Queued", "已排队")
          : status === "running" ? say("Waiting for a terminal receipt", "等待明确终态")
          : status === "unknown-needs-attention" ? say("Unknown effect — inspect the original operation; do not resend", "效果未知——检查原操作，不要重发")
          : say("Terminal record", "已记录终态");
        card.append(node("p", "", label + " · " + task.id + "/" + value.id));
      }
    } else card.append(node("p", "muted", entry.summary || say("Value omitted from compact read", "紧凑读取已省略正文")));
    const expand = node("button", "record-open", say("Read full record / source", "读取完整记录／来源"));
    expand.type = "button";
    expand.addEventListener("click", async () => {
      expand.disabled = true;
      try {
        const result = await actions.inspect(task.id, entry.ref);
        const content = node("pre", "surface-json", JSON.stringify(result.value, null, 2));
        card.append(content);
        if (result.result?.output) card.append(richText(say("Original execution report", "原始执行报告"), result.result.output, t));
        if (result.result?.diagnostic) card.append(richText(say("Execution diagnostic", "执行诊断"), result.result.diagnostic, t));
        if (result.execution) card.append(node("pre", "surface-json", JSON.stringify(result.execution, null, 2)));
        expand.remove();
      } catch {
        expand.disabled = false;
        expand.textContent = say("Record changed or unavailable; refresh context", "记录已变化或不可用；请刷新 Context");
      }
    });
    card.append(expand);
    return card;
  }
  function section(id, name, entries) {
    const body = node("div", "section-body");
    entries.forEach((entry) => body.append(recordCard(entry)));
    if (!entries.length) body.append(node("p", "muted", core.omitted.records
      ? say("Not included in this compact read", "此紧凑读取未包含该记录")
      : say("No records", "暂无记录")));
    scaffold.append(anchorSection(id, sectionHead(name, { count: entries.length }), body));
    return body;
  }
  const focus = section("detail-focus", say("Goal and current focus", "目标与当前关注"), records("task-brief"));
  const brief = values("task-brief")[0];
  if (brief) {
    focus.prepend(richText(t("detail.focus"), brief.currentFocus, t));
    if (brief.boundaries.length) focus.append(richText(say("Boundaries", "边界"), brief.boundaries.join("\\n"), t));
  }
  const questions = node("div", "section-body");
  records("input-request").filter((entry) => entry.omitted || entry.value.status === "open").forEach((entry) => {
    questions.append(entry.omitted ? recordCard(entry) : inputCard(entry.value, { single: true }, t, locale, actions));
  });
  scaffold.append(anchorSection("detail-attention", sectionHead(t("detail.attention")), questions));
  section("detail-work", say("Responsibilities and acceptance", "工作责任与验收"), records("work-item"));
  section("detail-results", say("Saved results and provenance", "已保存结果与来源"), records("artifact").concat(records("candidate")));
  section("detail-messages", t("detail.messages"), records("task-message"));
  section("detail-history", say("Decisions and milestones", "决策与里程碑"), records("task-decision").concat(records("task-milestone")));
  section("detail-reviews", t("detail.reviews"), records("review-round"));
  const roles = node("div", "section-body");
  records("role").forEach((entry) => {
    if (entry.omitted) { roles.append(recordCard(entry)); return; }
    const role = entry.value;
    const active = values("run").find((run) => run.roleName === role.name && run.status === "active");
    const incomplete = core.omitted.records > 0 || records("run").some((entry) => entry.omitted);
    roles.append(roleCard({
      ...role, providerRetry: entry.providerRetry,
      status: entry.providerRetry?.status === "waiting" ? "waiting" : active || incomplete ? "unknown" : "idle",
      effectiveLaunch: active ? active.effective : null,
      launchDrift: active && active.effective.sourceDesiredRevision !== role.launchRevision
    }, task, t, locale, actions));
    if (!active) roles.append(node("p", "muted", say(
      "No active AgentRun in this read; Session activity is a separate observation.",
      "此读取中没有活跃 AgentRun；Session 活动属于独立观察。")));
  });
  scaffold.append(anchorSection("detail-roles", sectionHead(t("detail.roles")), roles));
  const execution = node("details", "record-card");
  execution.append(node("summary", "", say("Execution and observations", "展开执行与观察")));
  execution.append(node("p", "muted", say(
    "An open execution record is not proof of Agent activity. Native admission and Task progress are separate facts.",
    "执行记录未结清不等于 Agent 正在工作；原生准入、运行观察与 Task 进展分别呈现。")));
  records("run").forEach((entry) => execution.append(entry.omitted ? recordCard(entry)
    : runCard({ ...entry.value, execution: entry.execution }, t, locale)));
  (core.observations || []).forEach((observation) => execution.append(node("p", "muted",
    observation.source + " · " + observation.status + " · " + observation.coverage + " · " + observation.observedAt)));
  const runtimeStatus = node("p", "muted", data.runtimeStatus + " · " + data.runtimeObservedAt);
  runtimeStatus.dataset.runtimeStatus = "";
  execution.append(runtimeStatus);
  const raw = node("pre", "surface-json", data.runtime ? JSON.stringify({
      roles: data.runtime.roles, runtimeHealth: data.runtime.runtimeHealth
    }, null, 2) : "");
  raw.dataset.runtimeValue = "";
  execution.append(raw);
  scaffold.append(anchorSection("detail-exec", sectionHead(t("detail.execution")), execution));
  section("detail-operations", say("Original operation facts (no automatic retry)", "原始操作事实（不自动重试）"), records("job"));
  const refs = node("details", "record-card");
  refs.append(node("summary", "", say("Context cursor and omitted references", "Context 游标与省略引用")));
  refs.append(node("pre", "surface-json", JSON.stringify({
    coreCursor: core.coreCursor, throughCursor: core.throughCursor, count: core.count, omitted: core.omitted
  }, null, 2)));
  refs.append(node("p", "muted", say("Reads do not acknowledge messages. Omitted records can be located with the CLI domain query and inspected by reference.",
    "读取不确认消息。被省略的记录可经 CLI 领域查询定位后按引用读取。")));
  scaffold.append(refs);
  const panels = node("details", "record-card");
  panels.append(node("summary", "", say("Capability panels", "能力面板")));
  const panelBody = node("div", "section-body");
  panels.append(panelBody);
  let loadingPanels = false;
  panels.addEventListener("toggle", async () => {
    if (!panels.open || loadingPanels) return;
    loadingPanels = true;
    panelBody.textContent = say("Reading current contributions…", "读取当前贡献…");
    try {
      const current = await actions.panels(task.id);
      clear(panelBody);
      panelBody.append(node("small", "muted", current.observedAt));
      if (!current.panels.length) panelBody.append(node("p", "muted", say("No visible panels", "暂无可见面板")));
      current.panels.forEach((item) => {
        const card = node("article", "record-card");
        const panel = item.panel;
        card.append(node("strong", "", panel.title), node("small", "muted", item.capability + " · " + item.provider.id));
        if (item.unavailable) card.append(node("p", "muted", item.unavailable));
        else if (panel.kind === "text") card.append(node("p", "", panel.text));
        else if (panel.kind === "link") {
          const url = new URL(panel.href);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
            const link = node("a", "", panel.title);
            link.href = url.href;
            link.rel = "noopener noreferrer";
            card.append(link);
          }
        } else if (panel.kind === "data" && panel.renderer === "json") {
          const label = node("label", "", say("Query input (JSON)", "查询输入（JSON）"));
          const input = node("textarea", "");
          input.value = JSON.stringify({ taskId: task.id });
          label.append(input);
          const contract = node("details", "");
          contract.append(node("summary", "", say("Input schema", "输入结构")));
          contract.append(node("pre", "surface-json", JSON.stringify(item.inputSchema, null, 2)));
          const read = node("button", "record-open", say("Read", "读取"));
          read.type = "button";
          const output = node("pre", "surface-json");
          read.addEventListener("click", async () => {
            if (read.disabled) return;
            read.disabled = true;
            try {
              const result = await actions.readPanel(task.id, {
                capability: item.capability, contractVersion: item.contractVersion, provider: item.provider
              }, JSON.parse(input.value));
              output.textContent = JSON.stringify(result, null, 2);
            } catch (error) { output.textContent = say("Panel unavailable: ", "面板不可用：") + error.message; }
            finally { read.disabled = false; }
          });
          card.append(label, contract, read, output);
        }
        panelBody.append(card);
      });
    } catch (error) { panelBody.textContent = say("Panels unavailable: ", "面板不可用：") + error.message; }
    finally { loadingPanels = false; }
  });
  scaffold.append(panels);
  container.append(scaffold);
}

// Render each task-32 §2.5 submission facet on its own line, never collapsed into
// a single "started". This repo has one current server contract: every submission
// returns its faceted receipt, so there is no old-server flat-disposition path to
// fall back to. A missing facet block is a contract violation, reported as a
// limited diagnostic rather than reinterpreted as a plausible flat result.
function renderSubmissionFacets(container, submission, say) {
  clear(container);
  if (!submission) {
    container.append(node("p", "muted",
      say("Submission receipt is missing its §2.5 facets.", "提交回执缺少 §2.5 分面字段。")));
    return;
  }
  const phaseText = {
    "active": say("Active — delivery context", "进行中 — 交付上下文"),
    "draft-planning": say("Draft, in planning", "草稿，规划中"),
    "draft-unplanned": say("Draft, not yet planned", "草稿，尚未规划")
  };
  const planningText = {
    "entered": say("Entered planning", "已进入规划"),
    "continued": say("Continued planning", "继续规划"),
    "none": say("No planning change", "规划无变化")
  };
  const activationText = {
    "requested": say("Activation requested", "已请求激活"),
    "pending": say("Activation pending", "激活待处理"),
    "failed": say("Activation failed", "激活失败"),
    "manual-required": say("Manual activation required", "需手动激活"),
    "execution-stopped": say("Execution stopped; not activated", "执行已停止；未激活"),
    "none": say("No activation", "无激活")
  };
  const deliveryText = {
    "queued": say("Leader queued to act now", "已为 Leader 排队处理"),
    "none": say("Leader not woken", "未唤醒 Leader")
  };
  const facts = [
    [say("Phase", "阶段"), phaseText[submission.phase] ?? submission.phase],
    [say("Planning", "规划"), planningText[submission.planning] ?? submission.planning],
    [say("Activation", "激活"), activationText[submission.activation] ?? submission.activation],
    [say("Delivery", "投递"), deliveryText[submission.delivery] ?? submission.delivery]
  ];
  for (const [label, value] of facts) {
    container.append(node("p", "muted", label + ": " + value));
  }
  const step = submission.nextStep;
  if (step) {
    const nextText = step.kind === "activate-manually"
      ? say("Next: request activation with an explicit environment (yui task activation request " + step.taskId + " --request-id <id> --environment <plan>).",
        "下一步：明确环境并请求激活（yui task activation request " + step.taskId + " --request-id <id> --environment <plan>）。")
      : step.kind === "start-execution"
      ? say("Next: start execution first, then request activation (" + step.taskId + ").",
        "下一步：先启动执行，再请求激活（" + step.taskId + "）。")
      : step.kind === "await-pending-activation"
      ? say("Next: waiting on the pending activation " + step.activationRef + ".",
        "下一步：等待待处理的激活 " + step.activationRef + "。")
      : step.kind === "resolve-failed-activation"
      ? say("Next: the prior activation failed (" + step.failure + "); retry with a new request or cancel " + step.activationRef + ".",
        "下一步：之前的激活失败（" + step.failure + "）；请用新请求重试或取消 " + step.activationRef + "。")
      : "";
    if (nextText) {
      const next = node("p", "", nextText);
      next.dataset.nextStep = step.kind;
      container.append(next);
    }
  }
}
`;
