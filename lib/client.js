window.__ModuleLoader__.load({
  id: "@dsh-local/dsh-customs-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    // Portal keeps the floating text out of the header's clipped box.
    let createPortal = null;
    try {
      createPortal = require("react-dom").createPortal;
    } catch {
      createPortal = null;
    }

    /** Settings namespace: the profile entry id of this plugin. */
    const NS = "customs-guard";

    /**
     * Shelved until DSH exposes a supported client→Host channel.
     * See the comment at the registration site for the two blockers.
     */
    const PILL_ENABLED = false;

    const MODES = [
      { value: "rules", label: "仅规则", note: "完全离线：未识别的命令直接拒绝。" },
      { value: "manual", label: "人工确认", note: "规则照常拦截危险命令；识别不了的命令弹给你确认，和没装插件一样。" },
      { value: "hybrid", label: "模型复核", note: "识别不了的命令交给模型判定；模型不可用则拒绝。" },
      { value: "native", label: "原生", note: "完全不审：直接交给执行面，用于临时排障或对照。" }
    ];
    const PROVIDERS = [
      { value: "deepseek", label: "DeepSeek 官方" },
      { value: "opencode-go", label: "opencode-go" }
    ];
    const DEFAULTS = {
      deepseek: { baseURL: "https://api.deepseek.com/v1", model: "deepseek-flash" },
      "opencode-go": { baseURL: "https://opencode.ai/inference/openai/v1", model: "deepseek-v4.1-flash" }
    };

    const ACCENT = "#4d6bfe";
    const BORDER = "1px solid rgba(127,127,127,.26)";
    const FIELD_BG = "rgba(127,127,127,.10)";

    const S = {
      page: { padding: "4px 2px 24px", maxWidth: 760, fontSize: 13 },
      title: { fontSize: 16, fontWeight: 600, margin: "0 0 6px" },
      hint: { fontSize: 12, opacity: 0.68, margin: "0 0 18px", lineHeight: 1.7 },
      row: { display: "flex", alignItems: "flex-start", gap: 16, padding: "14px 0", borderTop: "1px solid rgba(127,127,127,.16)" },
      label: { width: 104, flex: "0 0 104px", paddingTop: 9, opacity: 0.85 },
      control: { flex: 1, minWidth: 0 },
      input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 10px",
        fontSize: 13,
        color: "inherit",
        background: FIELD_BG,
        border: BORDER,
        borderRadius: 8,
        outline: "none"
      },
      note: { fontSize: 12, opacity: 0.62, marginTop: 8, lineHeight: 1.55 },
      footer: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 10,
        marginTop: 22,
        paddingTop: 16,
        borderTop: "1px solid rgba(127,127,127,.16)"
      },
      dirty: { flex: 1, fontSize: 12, color: "#e6a23c" },
      status: { flex: 1, fontSize: 12, opacity: 0.75 },
      button: {
        padding: "7px 18px",
        fontSize: 13,
        borderRadius: 8,
        cursor: "pointer",
        border: BORDER,
        background: "transparent",
        color: "inherit"
      },
      primary: {
        padding: "7px 18px",
        fontSize: 13,
        borderRadius: 8,
        cursor: "pointer",
        border: "none",
        background: ACCENT,
        color: "#fff"
      }
    };

    /** A pill group: no native dropdown, so the dark theme stays consistent. */
    function Segmented(props) {
      const { options, value, onChange, disabled } = props;
      return h(
        "div",
        {
          style: {
            display: "inline-flex",
            gap: 2,
            padding: 3,
            background: FIELD_BG,
            border: BORDER,
            borderRadius: 10
          }
        },
        options.map((option) => {
          const active = option.value === value;
          return h(
            "button",
            {
              key: option.value,
              type: "button",
              disabled: disabled === true,
              onClick: () => {
                if (!active && disabled !== true) onChange(option.value);
              },
              style: {
                border: "none",
                padding: "6px 14px",
                fontSize: 12.5,
                lineHeight: 1.4,
                borderRadius: 8,
                cursor: disabled === true ? "default" : "pointer",
                color: active ? "#fff" : "inherit",
                background: active ? ACCENT : "transparent",
                opacity: disabled === true && !active ? 0.55 : 1,
                transition: "background .12s ease, color .12s ease"
              }
            },
            option.label
          );
        })
      );
    }

    function Row(props) {
      return h(
        "div",
        { style: S.row },
        h("div", { style: S.label }, props.label),
        h("div", { style: S.control }, props.children)
      );
    }

    function AutoReviewPage(props) {
      const form = props.form;
      const [snap, setSnap] = React.useState(() => form.getSnapshot());
      const [status, setStatus] = React.useState("");
      // Fields edited but not yet written: the page only persists on 保存.
      const [pending, setPending] = React.useState({});
      // Fields already written this session: keeps the UI honest while the
      // shared describe mirror catches up.
      const [committed, setCommitted] = React.useState({});
      const [adding, setAdding] = React.useState(false);
      const [draftPreset, setDraftPreset] = React.useState({ name: "", baseURL: "", model: "" });
      const [probe, setProbe] = React.useState("idle");
      const [probeMessage, setProbeMessage] = React.useState("");

      React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form]);

      const base = { ...(snap.value || {}), ...committed };
      const value = { ...base, ...pending };
      const disabled = snap.writable === false;
      const mode = value.reviewMode || "rules";
      const presets = Array.isArray(value.presets) ? value.presets : [];
      const providerOptions = [
        ...PROVIDERS,
        ...presets.map((preset) => ({ value: preset.name, label: preset.name }))
      ];
      // A persisted `provider` can be missing (older profile, or a write that
      // landed before the describe mirror refreshed). Infer it from the stored
      // base URL so reopening the page never silently falls back to DeepSeek.
      const inferredProvider = (() => {
        const url = String(value.baseURL || "").replace(/\/+$/, "");
        if (url === "") return undefined;
        const hit = Object.entries(DEFAULTS).find(([, item]) => item.baseURL.replace(/\/+$/, "") === url);
        return hit === undefined ? undefined : hit[0];
      })();
      const provider = value.provider || inferredProvider || "deepseek";
      const preset = presets.find((item) => item.name === provider);
      const defaults = preset || DEFAULTS[provider] || DEFAULTS.deepseek;
      const savedKey =
        (typeof base.apiKey === "string" && base.apiKey.length > 0) || base.apiKeySet === true;
      const currentMode = MODES.find((m) => m.value === mode) || MODES[0];
      const changedFields = Object.keys(pending);
      const dirty = changedFields.length > 0;

      const edit = (field, next) => {
        setPending((current) => {
          const copy = { ...current };
          if (next === undefined || next === base[field]) delete copy[field];
          else copy[field] = next;
          return copy;
        });
        setStatus("");
      };

      const addPreset = () => {
        const name = draftPreset.name.trim();
        if (name === "") return;
        const next = [...presets.filter((item) => item.name !== name), { ...draftPreset, name }];
        edit("presets", next);
        edit("provider", name);
        edit("baseURL", draftPreset.baseURL.trim());
        edit("model", draftPreset.model.trim());
        setDraftPreset({ name: "", baseURL: "", model: "" });
        setAdding(false);
      };

      const saveAll = async () => {
        if (!dirty) return;
        setStatus("保存中…");
        try {
          const written = {};
          for (const field of changedFields) {
            const ok = await form.set(field, pending[field]);
            if (ok === false) {
              setStatus(`保存被拒绝：${field}（设置文档不可写）`);
              return;
            }
            written[field] = pending[field];
          }
          setCommitted((current) => ({ ...current, ...written }));
          setPending({});
          setStatus("已保存");
        } catch (error) {
          setStatus("保存失败：" + String((error && error.message) || error));
        }
      };

      const cancel = () => {
        setPending({});
        setStatus("已放弃更改");
      };

      // Mode is a switch, not a form field: it lands immediately so the next
      // tool call already uses it (the Host folds the patch in per call).
      const switchMode = async (next) => {
        setCommitted((current) => ({ ...current, reviewMode: next }));
        setStatus("切换中…");
        try {
          const ok = await form.set("reviewMode", next);
          if (ok === false) {
            setCommitted((current) => {
              const copy = { ...current };
              delete copy.reviewMode;
              return copy;
            });
            setStatus("切换失败：设置文档不可写");
            return;
          }
          setStatus("");
        } catch (error) {
          setStatus("切换失败：" + String((error && error.message) || error));
        }
      };

      // Direct probe from the renderer. The key lives in the settings document
      // again, so no Host route is involved (that route was removed).
      const testConnection = async () => {
        const key = pending.apiKey || value.apiKey || "";
        const base = (value.baseURL || defaults.baseURL || "").replace(/\/+$/, "");
        if (key === "") {
          setProbe("fail");
          setProbeMessage("请先在上一栏填入密钥，再测试");
          return;
        }
        if (base === "") {
          setProbe("fail");
          setProbeMessage("还没有 API 地址");
          return;
        }
        setProbe("testing");
        setProbeMessage("测试中…");
        try {
          const response = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
          if (response.ok) {
            setProbe("ok");
            setProbeMessage("连通正常：密钥有效，地址可达");
          } else {
            setProbe("fail");
            const detail =
              response.status === 401 ? "密钥无效" : response.status === 402 ? "账户余额不足" : `HTTP ${response.status}`;
            setProbeMessage(`连通失败：${detail}`);
          }
        } catch (error) {
          setProbe("fail");
          setProbeMessage("连通失败：" + String((error && error.message) || error));
        }
      };

      const onProvider = (next) => {
        const preset = presets.find((item) => item.name === next);
        const d = preset || DEFAULTS[next];
        // Reflect the choice locally first: `form.set` has been observed to be a
        // no-op for this field, and a page that ignores the click is worse than
        // one that shows the pick and leaves it dirty for the Save button.
        edit("provider", next);
        if (d) {
          edit("baseURL", d.baseURL);
          edit("model", d.model);
        }
        const pairs = [["provider", next]];
        if (d) pairs.push(["baseURL", d.baseURL], ["model", d.model]);
        void (async () => {
          for (const [field, value] of pairs) {
            try {
              await form.set(field, value);
            } catch {
              /* keep the pending value; the Save button remains the fallback */
            }
          }
        })();
      };

      return h(
        "div",
        { style: S.page },
        h("h2", { style: S.title }, "自动审核"),
        h(
          "p",
          { style: S.hint },
          "PowerShell 工具在执行前过一遍本地规则；未识别的命令可以交给你或模型判断。",
          "放行后仍走 DSH 原生执行面（沙箱、超时、截断不变），密钥只写入 Host 设置，不回显。"
        ),

        h(
          Row,
          { label: "审核模式" },
          h(Segmented, {
            options: MODES.map((m) => ({ value: m.value, label: m.label })),
            value: mode,
            disabled,
            onChange: (next) => switchMode(next)
          }),
          h("div", { style: S.note }, currentMode.note, " 切换立即生效，无需保存。")
        ),

        mode === "manual" &&
          h(
            Row,
            { label: "确认内容" },
            h(
              "div",
              { style: S.note },
              "弹窗会带上模型写的说明、完整命令、目录和规则判定理由；拒绝的命令不会执行。审批策略为「从不询问」时按拒绝处理。"
            )
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "提供商" },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8 } },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    gap: 2,
                    padding: 3,
                    background: FIELD_BG,
                    border: BORDER,
                    borderRadius: 10,
                    overflowX: "auto",
                    maxWidth: 420,
                    scrollbarWidth: "thin"
                  }
                },
                providerOptions.map((option) =>
                  h(
                    "button",
                    {
                      key: option.value,
                      type: "button",
                      disabled,
                      onClick: () => {
                        if (option.value === provider) return;
                        onProvider(option.value);
                      },
                      style: {
                        border: "none",
                        whiteSpace: "nowrap",
                        padding: "6px 12px",
                        fontSize: 12.5,
                        borderRadius: 8,
                        cursor: disabled ? "default" : "pointer",
                        color: option.value === provider ? "#fff" : "inherit",
                        background: option.value === provider ? ACCENT : "transparent"
                      }
                    },
                    option.label
                  )
                )
              ),
              h(
                "button",
                {
                  type: "button",
                  title: "添加自定义提供商",
                  disabled,
                  onClick: () => setAdding((current) => !current),
                  style: { ...S.button, padding: "4px 10px", fontSize: 14, lineHeight: 1.1 }
                },
                "+"
              )
            ),

            adding &&
              h(
                "div",
                { style: { display: "grid", gap: 6, marginTop: 10 } },
                h("input", {
                  style: S.input,
                  placeholder: "名称（如 kimi）",
                  value: draftPreset.name,
                  onChange: (e) => setDraftPreset({ ...draftPreset, name: e.target.value })
                }),
                h("input", {
                  style: S.input,
                  placeholder: "API 地址（https://…/v1）",
                  value: draftPreset.baseURL,
                  onChange: (e) => setDraftPreset({ ...draftPreset, baseURL: e.target.value })
                }),
                h("input", {
                  style: S.input,
                  placeholder: "模型（如 kimi-k2）",
                  value: draftPreset.model,
                  onChange: (e) => setDraftPreset({ ...draftPreset, model: e.target.value })
                }),
                h(
                  "div",
                  { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                  h("button", { type: "button", style: S.button, onClick: () => setAdding(false) }, "取消"),
                  h("button", { type: "button", style: S.primary, onClick: addPreset }, "添加")
                )
              ),

            h(
              "div",
              { style: S.note },
              provider === "opencode-go"
                ? "opencode-go 需要填写订阅提供的 API 地址（OpenAI 兼容 /chat/completions）。"
                : provider === "deepseek"
                  ? "默认地址 https://api.deepseek.com/v1。"
                  : "自定义提供商：填 OpenAI 兼容地址即可。"
            )
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "API 地址" },
            h("input", {
              style: S.input,
              type: "text",
              placeholder: defaults.baseURL || "https://…/v1",
              value: value.baseURL || "",
              disabled,
              onChange: (e) => edit("baseURL", e.target.value.trim())
            })
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "模型" },
            h("input", {
              style: S.input,
              type: "text",
              placeholder: defaults.model,
              value: value.model || "",
              disabled,
              onChange: (e) => edit("model", e.target.value.trim())
            })
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "API 密钥" },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8 } },
              h("input", {
                style: { ...S.input, flex: 1 },
                type: "password",
                autoComplete: "new-password",
                placeholder: savedKey ? "已保存（留空不修改）" : "粘贴密钥",
                value: pending.apiKey || "",
                disabled,
                onChange: (e) => edit("apiKey", e.target.value)
              }),
              // Connectivity probe: yellow idle, green reachable, red failed.
              h("button", {
                type: "button",
                title: probe === "testing" ? "测试中…" : probe === "ok" ? "连通正常" : probe === "fail" ? "连通失败（点我看原因）" : "点击测试连通性",
                onClick: () => testConnection(),
                style: {
                  width: 18,
                  height: 18,
                  flex: "0 0 18px",
                  borderRadius: "50%",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  background: probe === "ok" ? "#3fb950" : probe === "fail" ? "#f85149" : probe === "testing" ? "#e6a23c99" : "#e6a23c",
                  boxShadow: "0 0 0 3px rgba(127,127,127,.10)"
                }
              })
            ),
            h("div", { style: S.note }, probeMessage || (savedKey ? "已保存密钥；留空表示不修改。点右侧圆点可测连通性。" : "未配置密钥时，模型复核会被跳过（按拒绝处理）。"))
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "超时（毫秒）" },
            h("input", {
              style: S.input,
              type: "number",
              min: 1000,
              max: 60000,
              step: 500,
              value: value.timeoutMs === undefined ? 8000 : value.timeoutMs,
              disabled,
              onChange: (e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next >= 1000 && next <= 60000) edit("timeoutMs", next);
              }
            })
          ),

        mode === "hybrid" &&
          h(
            Row,
            { label: "共享缓存前缀" },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer" } },
              h("input", {
                type: "checkbox",
                checked: value.shareCachePrefix !== false,
                disabled,
                onChange: (e) => edit("shareCachePrefix", e.target.checked)
              }),
              h("span", { style: { fontSize: 12.5 } }, value.shareCachePrefix !== false ? "开：复用固定前缀，命中缓存价" : "关：每次换前缀，用来对照命中率")
            ),
            h("div", { style: S.note }, "关闭后会故意打乱系统提示（加随机标记），强制不命中缓存；只用于对比，日常建议开着。")
          ),

        mode !== "native" &&
          h(
            Row,
            { label: "规则下的删除复核" },
            h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: disabled ? "default" : "pointer" } },
              h("input", {
                type: "checkbox",
                checked: value.scopedModelReview !== false,
                disabled,
                onChange: (e) => edit("scopedModelReview", e.target.checked)
              }),
              h("span", { style: { fontSize: 12.5 } }, value.scopedModelReview !== false ? "开：规则放行的删除/写入仍交模型核对意图" : "关：规则说行就行，不再问模型")
            ),
            h("div", { style: S.note }, "开启后，工作目录内的删除/写入会额外做一次模型核对（约 0.5–1 秒），用于拦住「描述是一回事、命令是另一回事」。")
          ),

        mode === "hybrid" &&
          h(
            "div",
            { style: S.footer },
            h("div", { style: dirty ? S.dirty : S.status }, dirty ? `有 ${changedFields.length} 项 API 配置未保存` : status),
            h("button", { type: "button", style: S.button, disabled: !dirty, onClick: cancel }, "放弃更改"),
            h("button", { type: "button", style: { ...S.primary, opacity: dirty ? 1 : 0.5, cursor: dirty ? "pointer" : "default" }, disabled: dirty === false, onClick: saveAll }, "保存 API 配置")
          ),

        mode !== "hybrid" && status !== "" && h("div", { style: S.status }, status)
      );
    }

    /**
     * Live review pill in the session header, right of the 对话/轨迹 tabs.
     *
     * State comes from the Host route `/api/customs-guard/review`: a small ring
     * of in-flight reviews. The bar is deliberately soft — jelly edges, spring
     * fill, no hard cuts — and collapses to a quiet line when nothing is being
     * reviewed.
     */
    const REVIEW_POLL_MS = 700;
    const reduceMotion = () => {
      try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
      } catch {
        return false;
      }
    };

    const JELLY = {
      wrap: {
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 22,
        marginLeft: 6,
        userSelect: "none",
        maxWidth: 244,
        overflow: "hidden"
      },
      pillBox: { flex: "0 0 auto" },
      pill: {
        position: "relative",
        width: 104,
        flex: "0 0 104px",
        height: 14,
        borderRadius: 999,
        overflow: "hidden",
        background: "rgba(127,127,127,.16)",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,.35), 0 1px 0 rgba(255,255,255,.05)"
      },
      fill: {
        position: "absolute",
        inset: 0,
        borderRadius: 999,
        transformOrigin: "left center",
        background:
          "linear-gradient(90deg, #3fd07a 0%, #8fd14f 38%, #f0b428 70%, #a8324a 100%)",
        filter: "saturate(1.05)",
        boxShadow: "inset 0 2px 4px rgba(255,255,255,.35), inset 0 -2px 5px rgba(0,0,0,.28)"
      },
      gloss: {
        position: "absolute",
        left: 6,
        right: 6,
        top: 2,
        height: 4,
        borderRadius: 999,
        background: "linear-gradient(90deg, rgba(255,255,255,.55), rgba(255,255,255,.05))",
        opacity: 0.55,
        pointerEvents: "none"
      },
      card: {
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,.18)"
      },
      float: {
        position: "fixed",
        pointerEvents: "none",
        fontSize: 12,
        fontWeight: 700,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        padding: "1px 7px",
        borderRadius: 999,
        background: "rgba(15,17,22,.72)",
        boxShadow: "0 2px 8px rgba(0,0,0,.35)",
        textShadow: "0 1px 0 rgba(0,0,0,.6)",
        zIndex: 2147483000
      }
    };

    /**
     * Crit-style feedback: drifts up, fades late, and each instance owns its own
     * lifecycle. Rendered through a portal so the header never clips it.
     */
    function FloatText({ text, color, x, y, side, drift, onDone }) {
      const [phase, setPhase] = React.useState(0);
      React.useEffect(() => {
        const frame = requestAnimationFrame(() => setPhase(1));
        const timer = setTimeout(onDone, 2800);
        return () => {
          cancelAnimationFrame(frame);
          clearTimeout(timer);
        };
      }, []);
      const driftX = drift * (phase === 1 ? 1 : 0.15);
      const baseX = side === "left" ? "-100%" : "-50%";
      return h(
        "span",
        {
          style: {
            ...JELLY.float,
            left: x,
            top: y,
            color,
            opacity: phase === 1 ? 0 : 1,
            transform: `translate(calc(${baseX} + ${driftX}px), ${phase === 1 ? -18 : 0}px)`,
            transition: "transform 2.6s cubic-bezier(.18,.9,.25,1), opacity 2.6s ease-in"
          }
        },
        text
      );
    }

    function JellyReviewBar(props) {
      // The settings form is the only reliable mode source inside the desktop
      // renderer, where `/api` is not reachable from the dsh-app:// origin.
      const form = props?.form;
      const [formSnap, setFormSnap] = React.useState(() => (form?.getSnapshot !== undefined ? form.getSnapshot() : {}));
      React.useEffect(() => {
        if (form?.subscribe === undefined) return undefined;
        return form.subscribe(() => setFormSnap(form.getSnapshot()));
      }, [form]);
      const modeFromForm = formSnap?.reviewMode;
      const [snap, setSnap] = React.useState(null);
      const [ready, setReady] = React.useState(false);
      const [problem, setProblem] = React.useState(null);
      const [pos, setPos] = React.useState(1);
      const [probe, setProbe] = React.useState("idle");
      const [probeMs, setProbeMs] = React.useState(0);
      const [probeDetail, setProbeDetail] = React.useState("");
      const [floats, setFloats] = React.useState([]);
      const floatSeq = React.useRef(0);
      const resetRef = React.useRef(null);
      const targetRef = React.useRef(0);
      const motionRef = React.useRef(false);
      const valueRef = React.useRef(0);
      const velocityRef = React.useRef(0);

      React.useEffect(() => {
        let stopped = false;
        const tick = async () => {
          try {
            const response = await fetch("/api/customs-guard/review", { cache: "no-store" });
            if (!response.ok) {
              // Keep the code visible: 401 vs 403 vs 404 need different fixes.
              if (!stopped) {
                setReady(false);
                setProblem(`HTTP ${response.status}`);
              }
              return;
            }
            const data = await response.json();
            if (stopped) return;
            setSnap(data);
            setReady(true);
            setProblem(null);
            const active = Array.isArray(data.active) ? data.active.length : 0;
            targetRef.current = active === 0 ? 1 : Math.min(0.86, 0.28 + active * 0.2);
          } catch (error) {
            if (!stopped) {
              setReady(false);
              setProblem(`ERR ${String((error && error.message) || error).slice(0, 24)}`);
            }
          }
        };
        tick();
        const timer = setInterval(tick, REVIEW_POLL_MS);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, []);

      // Spring fill: one continuous loop easing toward the current target, so a
      // target that changes without the item count (probe result) still moves.
      React.useEffect(() => {
        motionRef.current = reduceMotion() === false;
        if (!motionRef.current) {
          valueRef.current = targetRef.current;
          setPos(targetRef.current);
          return;
        }
        let stopped = false;
        let raf = 0;
        const step = () => {
          if (stopped) return;
          // Under-damped on purpose: the fill should overshoot and settle, not
          // glide. Too much damping was why the red slam looked flat.
          const stiffness = 0.26;
          const damping = 0.62;
          const delta = targetRef.current - valueRef.current;
          velocityRef.current = (velocityRef.current + delta * stiffness) * damping;
          valueRef.current += velocityRef.current;
          setPos(valueRef.current);
          raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => {
          stopped = true;
          cancelAnimationFrame(raf);
        };
      }, []);

      // Connectivity probe: the pill itself is the button (design.txt's
      // "drain to empty shell" state while the Host calls the provider).
      const probeMsLabel = (ms) => `${typeof ms === "number" ? ms : 0}ms`;
      const spawn = (text, color, anchor) => {
        floatSeq.current += 1;
        const id = floatSeq.current;
        const drift = Math.round((Math.random() - 0.5) * 22);
        const x = anchor?.x ?? 0;
        const y = anchor?.y ?? 0;
        const side = anchor?.side ?? "left";
        // Every float owns its own entry and timer: no global slot reuse.
        setFloats((current) => [...current, { id, text, color, drift, x, y, side }]);
        return id;
      };
      const dropFloat = (id) => setFloats((current) => current.filter((item) => item.id !== id));
      const anchorOf = (event) => {
        const rect = event?.currentTarget?.getBoundingClientRect?.();
        if (rect === undefined || rect === null) return { x: 0, y: 0 };
        // Float to the *left* of the capsule. Straight up runs into the native
        // window buttons (min/max/close), which a page can never paint over.
        return { x: rect.left - 8, y: rect.top + 1, side: "left" };
      };
      const cooldownUntil = React.useRef(0);
      const lastResult = React.useRef(null);
      const COOLDOWN_MS = 5000;

      const runProbe = async (event) => {
        const anchor = anchorOf(event);
        if (snap?.reviewMode !== undefined && snap.reviewMode !== "hybrid" && modeFromForm === undefined) {
          spawn("非模型审批模式", "#f5a623", anchor);
          velocityRef.current = -0.2;
          return;
        }
        // In the desktop renderer the /api route is unreachable from the
        // dsh-app:// origin; failing a probe every click just spams 400s.
        if (snap === null) {
          spawn("状态接口不可用", "#8a8f98", anchor);
          velocityRef.current = -0.2;
          return;
        }
        // Debounce: a real check only starts from the green idle state. Clicks
        // during the cooldown just repeat the previous verdict and extend the wait.
        if (probe === "testing" || Date.now() < cooldownUntil.current) {
          const previous = lastResult.current;
          cooldownUntil.current = Math.max(cooldownUntil.current, Date.now() + COOLDOWN_MS);
          clearTimeout(resetRef.current);
          resetRef.current = setTimeout(goIdle, COOLDOWN_MS);
          if (previous !== null) spawn(previous.text, previous.color, anchor);
          // Repeated clicks still get the squash-and-return feedback.
          velocityRef.current = -0.2;
          return;
        }
        setProbe("testing");
        setProbeDetail("");
        targetRef.current = 0.12;
        try {
          const response = await fetch("/api/customs-guard/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          });
          const raw = await response.text();
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = { ok: false, message: `HTTP ${response.status}` };
          }
          const ok = data?.ok === true;
          setProbe(ok ? "ok" : "fail");
          setProbeMs(typeof data?.ms === "number" ? data.ms : 0);
          const reason =
            ok
              ? ""
              : typeof data?.status === "number" && data.status !== 0
                ? `HTTP ${data.status}`
                : String(data?.message ?? `HTTP ${response.status}`);
          setProbeDetail(reason);
          const verdict = ok ? { text: `+${probeMsLabel(data?.ms)}`, color: "#57cf7f" } : { text: `× ${reason}`, color: "#e05a72" };
          lastResult.current = verdict;
          spawn(verdict.text, verdict.color, anchor);
          if (!ok) slamWine();
        } catch (error) {
          setProbe("fail");
          setProbeDetail(String((error && error.message) || error));
          lastResult.current = { text: "× 请求失败", color: "#e05a72" };
          spawn("× 请求失败", "#e05a72", anchor);
          slamWine();
        }
        targetRef.current = 1;
        cooldownUntil.current = Date.now() + COOLDOWN_MS;
        clearTimeout(resetRef.current);
        resetRef.current = setTimeout(goIdle, COOLDOWN_MS);
      };

      const goIdle = () => {
        setProbe("idle");
        setProbeDetail("");
      };

      /**
       * Wine slam: jump to full, then throw it back to about half and let the
       * spring carry it up again. The rebound is the part the eye reads as "被顶回来".
       */
      const slamWine = () => {
        valueRef.current = 1;
        velocityRef.current = -0.45;
      };

      // Always render something: a silent null made "wrong slot" and "route
      // unavailable" indistinguishable in the UI.
      const live = ready && snap !== null;
      const active = live && Array.isArray(snap.active) ? snap.active : [];
      const latest = live ? snap.latest : null;
      const modeValue = modeFromForm ?? snap?.reviewMode;
      // Mango yellow means "this deployment is not doing model review": there is
      // nothing to probe, so the pill must not pretend to be ready.
      const modelMode = modeValue === undefined ? true : modeValue === "hybrid";
      const running = active.length > 0;
      const phase = running ? active[0].phase : "idle";
      const failed = modelMode && (probe === "fail" || (!running && latest !== null && latest.status === "denied"));
      const settled = modelMode && (probe === "ok" || (!running && latest !== null && latest.status === "allowed"));

      const scale = Math.max(probe === "testing" ? 0.12 : 0.02, Math.min(1.22, pos));
      // The pill clips its fill, so a scaleX overshoot would be invisible. Squash
      // the whole capsule instead, and squash on undershoot too: the dip is what
      // makes repeated clicks feel springy rather than dead.
      const squash = 1 - Math.min(0.24, Math.abs(pos - 1) * 1.6);
      const hue = modelMode === false
        ? "linear-gradient(90deg,#f3b43f 0%,#f5a623 55%,#e08a1e 100%)"
        : failed
          ? "linear-gradient(90deg,#7d2038 0%,#a8324a 55%,#c9556a 100%)"
          : settled
            ? "linear-gradient(90deg,#2fbe6b 0%,#57cf7f 60%,#9be08a 100%)"
            : "linear-gradient(90deg,#2fbe6b 0%,#46c877 55%,#7fdd8e 100%)";

      const text =
        modelMode === false
          ? "未就绪"
          : probe === "testing"
            ? "测试中…"
            : probe === "ok"
              ? `连通 ${probeMs}ms`
              : probe === "fail"
                ? `连通失败 ${probeDetail}`
                : !live
                  ? "状态未知"
                  : running
                    ? phase === "model"
                      ? `模型复核 ${active.length}`
                      : `审核中 ${active.length}`
                    : "审核空闲";

      const floatNodes = floats.map((item) =>
        h(FloatText, {
          key: item.id,
          text: item.text,
          color: item.color,
          x: item.x,
          y: item.y,
          side: item.side,
          drift: item.drift,
          onDone: () => dropFloat(item.id)
        })
      );

      return h(
        "div",
        {
          style: { ...JELLY.wrap, cursor: running || probe === "testing" ? "default" : "pointer" },
          title: live ? `${text}${probeDetail === "" ? "" : `\n${probeDetail}`}` : `${text}${problem === null ? "" : `\n状态接口：${problem}`}`,
          onClick: runProbe
        },
        h(
          "div",
          {
            style: {
              ...JELLY.pill,
              transform: `scaleY(${squash})`,
              transformOrigin: "left center",
              transition: reduceMotion() ? "transform .18s ease" : "none"
            }
          },
          h("div", {
            style: {
              ...JELLY.fill,
              background: hue,
              transform: `scaleX(${scale})`,
              transition: reduceMotion() ? "transform .25s ease" : "none"
            }
          }),
          h("div", { style: JELLY.gloss }),
          active
            .slice(1, 3)
            .map((item, index) =>
              h("div", {
                key: item.id,
                style: {
                  ...JELLY.card,
                  transform: `translateY(${(index + 1) * 3}px) scale(${1 - (index + 1) * 0.06})`,
                  opacity: 0.5 - index * 0.15
                }
              })
            )
        ),
        floats.length > 0
          ? (createPortal === null ? h(React.Fragment, null, floatNodes) : createPortal(floatNodes, document.body))
          : null
      );
    }

    /** Required services (cordis fiber inject). */
    const inject = ["slots", "configForms"];

    function apply(ctx) {
      const form = ctx.configForms.get(NS);
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "customs-guard",
                order: 45,
                label: () => "自动审核",
                inject: () => ({ form })
              },
              AutoReviewPage
            )
          ),
        "customs-guard: settings page"
      );

      // Live review pill — SHELVED.
      //
      // The pill needs live review state, and the desktop renderer can reach
      // neither the Host `/api` route (the page origin is dsh-app://, so a
      // relative fetch is answered by the app protocol with 400) nor any preload
      // IPC bridge (the packaged app exposes no `exposeInMainWorld` surface).
      //
      // The implementation below is kept intact: flip PILL_ENABLED to true once
      // DSH gives plugin clients a supported Host channel. Until then the pill
      // would only report "状态未知", which is worse than not showing it.
      if (PILL_ENABLED) {
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.session.header.utilities", () =>
              ctx.slots.register(
                {
                  name: "conversation.session.header.utilities",
                  id: "customs-guard-review",
                  order: 60,
                  inject: () => ({ form })
                },
                JellyReviewBar
              )
            ),
          "customs-guard: review pill"
        );
      }
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
