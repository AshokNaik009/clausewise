import { sha256 } from "./normalization.js";
import type { Analysis, Finding, ThemeResult, VerifiedCitationData } from "./schemas.js";

const policyGapDisclaimer = "This analysis compares an external requirement with publicly disclosed policy posture only. It is not evidence of the organization’s complete internal control environment.";
const materialityOrder = new Map([["critical", 0], ["high", 1], ["medium", 2], ["low", 3], ["no_material_change", 4]]);

function markdown(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function citation(citation: VerifiedCitationData): string {
  const location = citation.page_start === null
    ? `lines ${citation.global_line_start}-${citation.global_line_end}`
    : `pages ${citation.page_start}-${citation.page_end}, lines ${citation.global_line_start}-${citation.global_line_end}`;
  const heading = citation.heading_start ? `; ${markdown(citation.heading_start)}` : "";
  return `- ${citation.document_id}, ${location}${heading}: “${citation.excerpt}”`;
}

function profileAssessment(value: Record<string, unknown>): string {
  return Object.entries(value).map(([key, item]) => `- ${key}: ${typeof item === "string" ? markdown(item) : JSON.stringify(item)}`).join("\n");
}

function renderFinding(finding: Finding): string {
  const action = finding.action_candidate
    ? `${markdown(finding.action_candidate.description)} (${finding.action_candidate.action_type}; ${finding.action_candidate.review_disposition})`
    : "No action candidate required.";
  return [
    `### ${finding.id} — ${markdown(finding.title)}`,
    "",
    finding.summary,
    "",
    `- Materiality: ${finding.materiality}`,
    `- Confidence: ${finding.confidence}`,
    `- Materiality rationale: ${markdown(finding.materiality_rationale)}`,
    `- Action candidate: ${action}`,
    "",
    "Profile assessment:",
    profileAssessment(finding.profile_assessment),
    "",
    "Verified evidence:",
    ...finding.evidence.map(citation),
    "",
  ].join("\n");
}

function sortedFindings(themes: ThemeResult[]): Finding[] {
  return themes.flatMap((theme, themeIndex) => theme.findings.map((finding) => ({ finding, themeIndex })))
    .sort((left, right) => (materialityOrder.get(left.finding.materiality) ?? 99) - (materialityOrder.get(right.finding.materiality) ?? 99) || left.themeIndex - right.themeIndex || left.finding.id.localeCompare(right.finding.id))
    .map(({ finding }) => finding);
}

export function renderReport(analysis: Analysis, classification = "recorded in manifest"): string {
  const sourceRows = analysis.sources.map((source) => `| ${source.document_id} | ${markdown(source.display_name)} | ${source.sha256} |`).join("\n");
  const lines = [
    "# DEEPAGENT HARNESS Regulatory Document Comparison",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Profile | ${analysis.profile} |`,
    `| Run ID | ${analysis.run_id} |`,
    `| Completion status | ${analysis.completion_status} |`,
    `| Classification | ${classification} |`,
    "",
    "| Source | File | SHA-256 |",
    "| --- | --- | --- |",
    sourceRows,
    "",
  ];
  if (analysis.profile === "policy-gap") lines.push(`> ${policyGapDisclaimer}`, "");
  lines.push(
    "## Executive summary",
    "",
    `Critical: ${analysis.summary.critical} | High: ${analysis.summary.high} | Medium: ${analysis.summary.medium} | Low: ${analysis.summary.low} | No material change: ${analysis.summary.no_material_change}`,
    "",
    "## Scope and coverage",
    "",
    `- Ingestion page ratio: ${typeof analysis.coverage.ingestion_page_ratio === "number" ? analysis.coverage.ingestion_page_ratio : JSON.stringify(analysis.coverage.ingestion_page_ratio)}`,
    `- Mapper heading ratio: ${analysis.coverage.mapper_heading_ratio}`,
    `- Mapper body sample ratio: ${analysis.coverage.mapper_body_sample_ratio}`,
    `- Theme outcome ratio: ${analysis.coverage.theme_outcome_ratio}`,
    `- Verified finding ratio: ${analysis.coverage.verified_finding_ratio}`,
    `- Fixture required concept ratio: ${analysis.coverage.fixture_required_concept_ratio ?? "not applicable"}`,
    "",
  );
  if (analysis.excluded_themes.length) {
    lines.push("## Excluded themes", "");
    for (const excluded of analysis.excluded_themes) lines.push(`- ${excluded.theme_id}: ${excluded.reason_code} — ${markdown(excluded.description)}`);
    lines.push("");
  }
  lines.push("## Theme findings", "");
  const findings = sortedFindings(analysis.themes);
  if (!findings.length) lines.push("No publishable findings were accepted.", "");
  else lines.push(...findings.flatMap((finding) => [renderFinding(finding)]));
  lines.push("## Final reviewer dispositions", "");
  const dispositions = analysis.final_review.dispositions;
  if (!dispositions.length) lines.push("No critical or high action dispositions were required.", "");
  else lines.push(...dispositions.map((disposition) => `- ${disposition.finding_id}: ${disposition.value}`), "");
  lines.push("## Limitations", "", ...analysis.limitations.map((limitation) => `- ${markdown(limitation)}`), "");
  lines.push("## Audit appendix", "", `- Final review artifact: reviews/final-${analysis.final_review.round}.json`, "- Canonical analysis artifact: analysis.json", "- Report rendering is deterministic from audited analysis.json.", "");
  return lines.join("\n");
}

export function reportHash(analysis: Analysis, classification = "recorded in manifest"): string {
  return sha256(renderReport(analysis, classification));
}

export function policyGapDisclaimerText(): string {
  return policyGapDisclaimer;
}
