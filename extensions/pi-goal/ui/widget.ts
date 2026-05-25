import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

import { renderDashboardLines } from "./dashboard-renderer.ts";
import {
  appendRightAlignedAdaptiveHint,
  getTuiSize,
  joinPartsToWidth,
  truncateDisplayText,
} from "./tui-layout.ts";
import { formatMetricValue } from "./metric-format.ts";
import type { SessionRuntime } from "../support/runtime.ts";
import { buildResearchSummaryFromState, isBetterMetric } from "../domain/research-summary.ts";

export interface WidgetController {
  update(ctx: ExtensionContext, runtime: SessionRuntime): void;
  clear(ctx: ExtensionContext): void;
}

export function createWidgetController(options: {
  dashboardHintVariants(toggleAction: "expand" | "collapse"): string[];
}): WidgetController {
  const clear = (ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.setWidget("goal", undefined);
    }
  };

  const update = (ctx: ExtensionContext, runtime: SessionRuntime) => {
    if (!ctx.hasUI) return;

    const state = runtime.state;

    if (state.results.length === 0) {
      if (!runtime.activeRun) {
        ctx.ui.setWidget("goal", undefined);
        return;
      }

      ctx.ui.setWidget("goal", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const runningLine = joinPartsToWidth(
            [
              theme.fg("accent", "🎯"),
              theme.fg("warning", " running…"),
              state.name ? theme.fg("dim", ` │ ${state.name}`) : "",
              theme.fg("dim", ` │ ${runtime.activeRun?.command ?? ""}`),
              theme.fg("dim", " │ waiting for first logged result"),
            ],
            safeWidth
          );
          return [runningLine];
        },
        invalidate(): void {},
      }));
      return;
    }

    if (runtime.dashboardExpanded) {
      ctx.ui.setWidget("goal", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const title = truncateDisplayText(
            `🎯 goal${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);
          const rows = safeWidth < 95 ? 4 : 6;

          return [
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            ),
            ...renderDashboardLines(
              state,
              safeWidth,
              theme,
              rows,
              options.dashboardHintVariants("collapse")
            ),
          ];
        },
        invalidate(): void {},
      }));
    } else {
      ctx.ui.setWidget("goal", (tui, theme) => ({
        render(width: number): string[] {
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const summary = buildResearchSummaryFromState(state);
          const counts = summary.currentExperiment.statusCounts;
          const kept = counts.keep;
          const crashed = counts.crash;
          const checksFailed = counts.checks_failed;
          const baseline = summary.currentExperiment.baseline;
          const best = summary.currentExperiment.best;
          const displayVal = best?.metric ?? baseline?.metric ?? null;
          const essential = [
            theme.fg("accent", "🎯"),
            theme.fg("muted", ` ${state.results.length} runs`),
            theme.fg("success", ` ${kept} kept`),
            theme.fg("dim", " │ "),
            theme.fg(
              "warning",
              theme.bold(`★ ${state.metricName}: ${formatMetricValue(displayVal, state.metricUnit)}`)
            ),
            best ? theme.fg("dim", ` #${best.runNumber}`) : "",
          ];

          const optional: string[] = [];
          if (crashed > 0) optional.push(theme.fg("error", ` ${crashed}💥`));
          if (checksFailed > 0) optional.push(theme.fg("error", ` ${checksFailed}⚠`));

          if (best?.deltaPercent !== null && best?.deltaPercent !== undefined && baseline) {
            const pct = best.deltaPercent;
            const sign = pct > 0 ? "+" : "";
            const deltaColor = isBetterMetric(best.metric, baseline.metric, state.bestDirection)
              ? "success"
              : "error";
            optional.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
          }

          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] = state.confidence >= 2.0 ? "success" : state.confidence >= 1.0 ? "warning" : "error";
            optional.push(theme.fg("dim", " │ "));
            optional.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          if (state.secondaryMetrics.length > 0) {
            for (const sm of state.secondaryMetrics) {
              const val = best?.metrics[sm.name];
              const bv = summary.currentExperiment.baselineSecondary[sm.name];
              if (val === undefined) continue;
              let secText = `${sm.name}: ${formatMetricValue(val, sm.unit)}`;
              if (bv !== undefined && bv !== 0 && val !== bv) {
                const p = ((val - bv) / bv) * 100;
                const s = p > 0 ? "+" : "";
                const c = val <= bv ? "success" : "error";
                secText += theme.fg(c, ` ${s}${p.toFixed(1)}%`);
              }
              optional.push(theme.fg("dim", "  "));
              optional.push(theme.fg("muted", secText));
              break;
            }
          }

          if (state.name) optional.push(theme.fg("dim", ` │ ${state.name}`));

          const left = [...essential, ...optional].join("");
          const hintVariants = options.dashboardHintVariants("expand");
          return [
            hintVariants.length > 0
              ? appendRightAlignedAdaptiveHint(left, safeWidth, theme, hintVariants)
              : truncateToWidth(left, safeWidth, "…", true),
          ];
        },
        invalidate(): void {},
      }));
    }
  };

  return { update, clear };
}
