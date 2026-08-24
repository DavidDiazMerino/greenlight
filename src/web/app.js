const app = document.querySelector("#app");

const fmtRate = (value) => `${Math.round(Number(value) * 100)}%`;
const shortHash = (value) => value?.startsWith("sha256:") ? `sha256:${value.slice(7, 19)}…` : value;
const safe = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const list = (value) => Array.isArray(value) ? value : [];
const metricLabel = {
  caption_safe_area_pass_rate: "Caption safe area",
  output_validity_pass_rate: "Output validity",
  p95_render_duration: "Render duration p95",
  run_coverage: "Run coverage",
};

function value(gate, variant) {
  const number = Number(gate[variant]);
  if (gate.unit === "rate") return fmtRate(number);
  if (gate.unit === "ms") return `${Math.round(number)} ms`;
  return `${number} runs`;
}

function bboxStyle(bounds) {
  if (!bounds) return "display:none";
  const numeric = [bounds.x, bounds.y, bounds.width, bounds.height].map(Number);
  if (numeric.some((item) => !Number.isFinite(item))) return "display:none";
  const [x, y, width, height] = numeric;
  return `left:${x / 10.8}%;top:${y / 19.2}%;width:${width / 10.8}%;height:${height / 19.2}%`;
}

function videoPanel(card, variant) {
  const isBaseline = variant === "baseline";
  const bounds = isBaseline ? card.hero.baselineBounds : card.hero.candidateBounds;
  const path = isBaseline ? card.hero.baselineVideo : card.hero.candidateVideo;
  const poster = isBaseline ? card.hero.baselinePoster : card.hero.candidatePoster;
  const gate = list(card.gates).find((item) => item.metric === "caption_safe_area_pass_rate");
  const passed = gate && (isBaseline ? gate.baseline === 1 : gate.candidate === 1);
  return `<article class="video-panel ${passed ? "pass" : "fail"}">
    <div class="video-title"><span>${isBaseline ? "BASELINE" : "CANDIDATE"}</span><b>${safe(isBaseline ? card.baselineVersion : card.candidateVersion)}</b></div>
    <div class="portrait-wrap">
      <video class="portrait-video" data-variant="${variant}" muted loop playsinline preload="metadata" poster="${safe(poster)}" src="${safe(path)}"></video>
      <div class="safe-area"><span>9:16 SAFE AREA</span></div>
      <div class="measured-bbox" style="${bboxStyle(bounds)}"><span>PIXEL DIFF BOUNDS</span></div>
      <button class="play-toggle" type="button" aria-label="Play synchronized baseline and candidate evidence">▶</button>
    </div>
    <div class="video-result"><i></i>${passed ? "Caption pixels contained" : "Hard gate violated"}</div>
  </article>`;
}

function confidenceComponent(component) {
  const value = Number(component.value);
  const signed = Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${Math.round(value * 100)} pts` : "—";
  return `<li><span>${safe(component.name?.replaceAll("_", " "))}</span><b>${safe(signed)}</b><small>${safe(component.basis)}</small></li>`;
}

function evidenceRow(item) {
  const relationship = item.relationship === "contradicts" ? "contradicts" : item.relationship === "context" ? "context" : "supports";
  return `<article class="evidence-row ${relationship}">
    <div class="evidence-kind"><span>${safe(item.sourceType)}</span><b>${safe(relationship)}</b></div>
    <p>${safe(item.claim)}</p>
    <dl><div><dt>PRODUCER</dt><dd>${safe(item.provenance?.producer)}</dd></div><div><dt>ARTIFACT</dt><dd>${safe(item.provenance?.artifact)}</dd></div><div><dt>CONTENT</dt><dd title="${safe(item.contentFingerprint)}">${safe(shortHash(item.contentFingerprint))}</dd></div></dl>
    <div class="evidence-flags"><span>${safe(item.provenance?.scope)}</span><span>${item.authoritative ? "authoritative within fixture" : "context only"}</span><span>${item.synthetic ? "synthetic" : "observed"}</span></div>
  </article>`;
}

function invariantRow(check) {
  const passed = check.candidatePass === true;
  const measurement = check.measurement;
  const measured = measurement
    ? `${measurement.unit === "rate" ? fmtRate(measurement.candidate) : safe(measurement.candidate)} · ${safe(measurement.threshold)}`
    : "result fingerprinted";
  return `<li class="invariant ${passed ? "pass" : "fail"}"><span class="status-dot">${passed ? "✓" : "!"}</span><div><b>${safe(check.invariantName)}</b><small>${safe(check.severity)} · ${measured}</small><code>${safe(check.invariantId)}</code></div></li>`;
}

function truth(value) {
  return value === true ? '<span class="truth yes">YES</span>' : '<span class="truth no">NO</span>';
}

function render(card) {
  const failed = list(card.gates).filter((gate) => !gate.pass);
  const local = card.provenance === "local/synthetic";
  const casefile = card.evidenceCasefile ?? {};
  const evidence = list(casefile.evidence);
  const contradictions = list(casefile.contradictions);
  const signal = casefile.signal ?? {};
  const resilience = casefile.resilience ?? {};
  const applicability = resilience.applicability ?? {};
  const reproduction = resilience.reproducibility ?? {};
  const sourceTypes = new Set(evidence.map((item) => item.sourceType)).size;
  const confidence = Math.round(Number(signal.confidence ?? 0) * 100);
  const canaryChecks = list(card.canaryRun?.checks);
  const blocking = canaryChecks.filter((item) => item.severity === "blocking" && !item.candidatePass);
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="brand-mark">G</span><div><strong>GREENLIGHT</strong><small>Evidence before publish</small></div></div>
      <div class="provenance ${local ? "local" : "live"}"><span></span>${safe(card.provenance)} · ${card.synthetic ? "SYNTHETIC DEMO" : "LIVE EVIDENCE"}</div>
      <div class="experiment">EXPERIMENT <strong>${safe(card.experimentId)}</strong></div>
    </header>

    <section class="decision-banner">
      <div class="decision-word"><span class="pulse"></span>${safe(card.decision)}</div>
      <div class="decision-copy"><div>BASELINE <span>→</span> RELEASE CANDIDATE</div><h1>${card.deploymentBlocked ? "DEPLOYMENT BLOCKED" : "ELIGIBLE FOR HUMAN PROMOTION"}</h1></div>
      <div class="coverage"><strong>${safe(card.runCoverage)}/16</strong><span>RUNS VERIFIED</span></div>
    </section>

    <section class="workflow-impact" aria-labelledby="workflow-impact-title">
      <div><span>WHY THIS AFFECTS MAYA</span><h2 id="workflow-impact-title">The candidate changes the compositor on her portrait finishing path.</h2></div>
      <p>${safe(card.change?.workflowImpact)}</p>
      <div class="change-route"><b>${safe(card.change?.fromVersion)}</b><span>→</span><b>${safe(card.change?.toVersion)}</b><small>${list(card.change?.affectedStages).map(safe).join(" · ")}</small></div>
    </section>

    <section class="workspace">
      <div class="visual-column">
        <div class="section-heading"><div><span>01</span> RENDERED OUTPUT IS THE SOURCE OF TRUTH</div><p>Clip ${safe(card.hero.clipId)} · synchronized portrait evidence</p></div>
        <div class="comparison">
          ${videoPanel(card, "baseline")}
          <div class="versus"><span>VS</span></div>
          ${videoPanel(card, "candidate")}
        </div>
      </div>

      <aside class="decision-column">
        <div class="headline-block"><span>MEASURED CANARY RESULT</span><h2>${safe(card.headline)}</h2></div>
        <div class="gates">
          ${list(card.gates).map((gate) => `<div class="gate ${gate.pass ? "pass" : "fail"}">
            <div class="gate-icon">${gate.pass ? "✓" : "!"}</div>
            <div><span>${safe(metricLabel[gate.metric] ?? gate.metric)}</span><strong>${value(gate, "candidate")}</strong><small>baseline ${value(gate, "baseline")} · ${safe(gate.threshold)}</small></div>
          </div>`).join("")}
        </div>
        <div class="diagnosis"><span>DIAGNOSIS</span><p>${safe(card.diagnosis)}</p></div>
        <div class="action"><span>RECOMMENDED ACTION</span><p>${safe(card.recommendedAction)}</p></div>
      </aside>
    </section>

    <section class="evidence-section" aria-labelledby="evidence-title">
      <div class="section-heading evidence-heading"><div><span>02</span> EVIDENCE CASEFILE</div><p id="evidence-title">Every claim retains source, provenance, and content fingerprint.</p></div>
      <div class="evidence-summary">
        <article class="evidence-stat"><span>EVIDENCE</span><strong>${evidence.length}</strong><p>${sourceTypes} source types · ${safe(card.provenance)}</p></article>
        <article class="evidence-stat confidence-stat"><span>HEURISTIC CONFIDENCE</span><strong>${safe(confidence)}%</strong><p>${safe(signal.confidenceVersion)} · deterministic, not statistically calibrated</p></article>
        <article class="evidence-stat"><span>CONTRADICTIONS</span><strong>${contradictions.length}</strong><p>${safe(resilience.corroboration?.unresolvedBlockingContradictions ?? 0)} unresolved blocking</p></article>
        <article class="evidence-stat"><span>RECOMMENDATION ELIGIBLE</span><strong>${resilience.recommendationEligible ? "YES" : "NO"}</strong><p>Eligibility cannot override a failed policy gate.</p></article>
      </div>
      <div class="evidence-grid">
        <article class="case-panel">
          <span class="panel-label">CONFIDENCE BASIS</span>
          <ul class="confidence-components">${list(signal.confidenceComponents).map(confidenceComponent).join("")}</ul>
        </article>
        <article class="case-panel resilience-panel">
          <span class="panel-label">APPLICABILITY + REPRODUCTION</span>
          <dl class="check-grid">
            <div><dt>Component used</dt><dd>${truth(applicability.componentActuallyUsed)}</dd></div>
            <div><dt>Version matches</dt><dd>${truth(applicability.affectedVersionMatches)}</dd></div>
            <div><dt>Code path reached</dt><dd>${truth(applicability.codePathReachable)}</dd></div>
            <div><dt>Baseline passes</dt><dd>${truth(reproduction.baselinePasses)}</dd></div>
            <div><dt>Candidate fails</dt><dd>${truth(reproduction.candidateFails)}</dd></div>
            <div><dt>Reproduced</dt><dd>${truth(reproduction.reproduced)}</dd></div>
          </dl>
          <div class="contradiction"><b>CONTRADICTION DISCLOSED</b><p>${safe(contradictions[0]?.claim ?? "None recorded.")}</p></div>
        </article>
        <article class="case-panel invariant-panel">
          <span class="panel-label">${safe(card.canaryPack?.id)}@${safe(card.canaryPack?.version)} · ${safe(card.canaryPack?.cases?.length)} CASES</span>
          <ul class="invariants">${canaryChecks.map(invariantRow).join("")}</ul>
          <p class="blocking-note"><b>${blocking.length} blocking invariant failed.</b> The deterministic policy owns the HOLD; an agent suggestion cannot promote this candidate.</p>
        </article>
      </div>
      <details class="evidence-details">
        <summary><span>View evidence</span><small>${evidence.length} records · accessible provenance details</small></summary>
        <div class="evidence-list">${evidence.map(evidenceRow).join("")}</div>
      </details>
    </section>

    <section class="receipt">
      <div class="receipt-title"><span>03</span><div><strong>IMMUTABLE DECISION RECEIPT</strong><small>${safe(card.evidenceCompleteness)}</small></div></div>
      <dl>
        <div><dt>RECEIPT</dt><dd title="${safe(card.decisionReceiptFingerprint)}">${safe(shortHash(card.decisionReceiptFingerprint))}</dd><small>commits change + evidence + canary + policy + verdict</small></div>
        <div><dt>POLICY OWNER</dt><dd>${safe(card.policyOwner)}</dd><small>${safe(card.policyName)}@${safe(card.policyVersion)}</small></div>
        <div><dt>POLICY HASH</dt><dd title="${safe(card.policyHash)}">${safe(shortHash(card.policyHash))}</dd><small>thresholds fixed before evaluation</small></div>
        <div><dt>CASEFILE</dt><dd title="${safe(casefile.fingerprint)}">${safe(shortHash(casefile.fingerprint))}</dd><small>${evidence.length} evidence items</small></div>
        <div><dt>CANARY RUN</dt><dd title="${safe(card.canaryRun?.fingerprint)}">${safe(shortHash(card.canaryRun?.fingerprint))}</dd><small>${safe(card.canaryPack?.id)}@${safe(card.canaryPack?.version)}</small></div>
        <div><dt>TRACE PAIR</dt><dd>${safe(card.traceIds?.[0]?.slice(0, 12))}…</dd><small>${safe(card.traceIds?.[1]?.slice(0, 12))}… · local trace-shaped only</small></div>
      </dl>
      <div class="receipt-actions">
        <a class="button primary" href="/artifacts/latest/artifact-index.json" download>Download artifacts</a>
        <a class="button" href="/artifacts/latest/evidence-casefile.json" target="_blank" rel="noreferrer">Open casefile JSON</a>
        <a class="button" href="/artifacts/latest/decision-receipt.json" target="_blank" rel="noreferrer">Verify receipt</a>
        <button class="button" id="replay" data-command="${safe(card.replayCommand)}">Replay experiment</button>
        <button class="button disabled" title="No Grafana MCP receipts exist in this local fixture" disabled>Grafana MCP not connected</button>
      </div>
    </section>
    <footer><span>Every update is a hypothesis. Greenlight turns it into a production decision.</span><span>${failed.length} failed gate${failed.length === 1 ? "" : "s"} · completed ${safe(new Date(card.completedAt).toLocaleString())}</span></footer>`;

  const videos = [...document.querySelectorAll("video")];
  const buttons = [...document.querySelectorAll(".play-toggle")];
  const toggle = async () => {
    if (videos.some((video) => !video.paused)) {
      videos.forEach((video) => video.pause());
      buttons.forEach((button) => { button.textContent = "▶"; });
    } else {
      const at = Math.min(...videos.map((video) => Number.isFinite(video.currentTime) ? video.currentTime : 0));
      videos.forEach((video) => { video.currentTime = at; });
      await Promise.all(videos.map((video) => video.play()));
      buttons.forEach((button) => { button.textContent = "❚❚"; });
    }
  };
  buttons.forEach((button) => button.addEventListener("click", toggle));
  document.querySelector("#replay")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    await navigator.clipboard.writeText(button.dataset.command);
    button.textContent = "Copied: npm run canary";
  });
}

try {
  const response = await fetch("/artifacts/latest/decision-card.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  render(await response.json());
} catch (error) {
  app.innerHTML = `<section class="loading-card error"><div class="eyebrow">NO LOCAL EVIDENCE</div><h1>Run the deterministic canary first.</h1><p><code>npm run canary</code></p><small>${safe(error.message)}</small></section>`;
}
