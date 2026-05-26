import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatElapsed } from "../execution/experiment-runner.ts";
import { renderDashboardLines } from "./dashboard-renderer.ts";
import { clamp, getTuiSize, truncateDisplayText } from "./tui-layout.ts";
import type { SessionRuntime } from "../support/runtime.ts";

export interface DashboardOverlayController {
  open(ctx: ExtensionContext, runtime: SessionRuntime): Promise<void>;
  clear(): void;
  requestRender(): void;
}

export function createDashboardOverlayController(): DashboardOverlayController {
  let overlayTui: { requestRender: () => void } | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const clear = () => {
    overlayTui = null;
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  };

  const requestRender = () => {
    if (overlayTui) overlayTui.requestRender();
  };

  const open = async (ctx: ExtensionContext, runtime: SessionRuntime): Promise<void> => {
    const state = runtime.state;
    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
      let scrollOffset = 0;
      let lastViewportRows = 8;
      let lastTotalRows = 0;
      overlayTui = tui;

      spinnerInterval = setInterval(() => {
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
        if (runtime.activeRun) tui.requestRender();
      }, 80);

      const buildOverlayContent = (renderWidth: number): string[] => {
        const content = renderDashboardLines(state, renderWidth, theme, 0);
        if (runtime.activeRun) {
          const elapsed = formatElapsed(Date.now() - runtime.activeRun.startedAt);
          const frame = SPINNER[spinnerFrame % SPINNER.length];
          const nextIdx = state.results.length + 1;
          content.push(
            truncateToWidth(
              `  ${theme.fg("dim", String(nextIdx).padEnd(3))}` +
                theme.fg("warning", `${frame} running… ${elapsed}`),
              renderWidth,
              "…",
              true
            )
          );
        }
        return content;
      };

      return {
        render(width: number): string[] {
          const { height } = getTuiSize(tui);
          const safeWidth = Math.max(1, width || getTuiSize(tui).width);
          const viewportRows = Math.max(4, height - 4);
          const content = buildOverlayContent(safeWidth);

          const totalRows = content.length;
          const maxScroll = Math.max(0, totalRows - viewportRows);
          scrollOffset = clamp(scrollOffset, 0, maxScroll);
          lastViewportRows = viewportRows;
          lastTotalRows = totalRows;

          const out: string[] = [];

          const title = truncateDisplayText(
            `🎯 goal${state.name ? `: ${state.name}` : ""}`,
            Math.max(0, safeWidth - 5)
          );
          const fillLen = Math.max(0, safeWidth - 3 - 1 - visibleWidth(title) - 1);

          out.push(
            truncateToWidth(
              theme.fg("borderMuted", "───") +
                theme.fg("accent", ` ${title} `) +
                theme.fg("borderMuted", "─".repeat(fillLen)),
              safeWidth,
              "…",
              true
            )
          );

          const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
          for (const line of visible) out.push(truncateToWidth(line, safeWidth, "…", true));
          for (let i = visible.length; i < viewportRows; i++) out.push("");

          const scrollInfo = totalRows > viewportRows
            ? ` ${scrollOffset + 1}-${Math.min(scrollOffset + viewportRows, totalRows)}/${totalRows}`
            : "";
          const helpText = safeWidth >= 85
            ? ` ↑↓/j/k scroll • pgup/pgdn • g/G • esc close${scrollInfo} `
            : ` j/k scroll • esc close${scrollInfo} `;
          const footFill = Math.max(0, safeWidth - visibleWidth(helpText));

          out.push(
            truncateToWidth(
              theme.fg("borderMuted", "─".repeat(footFill)) + theme.fg("dim", helpText),
              safeWidth,
              "…",
              true
            )
          );

          return out;
        },

        handleInput(data: string): void {
          const maxScroll = Math.max(0, lastTotalRows - lastViewportRows);

          if (matchesKey(data, "escape") || data === "q") {
            done(undefined);
            return;
          }
          if (matchesKey(data, "up") || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
          } else if (matchesKey(data, "down") || data === "j") {
            scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          } else if (matchesKey(data, "pageUp") || data === "u") {
            scrollOffset = Math.max(0, scrollOffset - lastViewportRows);
          } else if (matchesKey(data, "pageDown") || data === "d") {
            scrollOffset = Math.min(maxScroll, scrollOffset + lastViewportRows);
          } else if (data === "g") {
            scrollOffset = 0;
          } else if (data === "G") {
            scrollOffset = maxScroll;
          }
          tui.requestRender();
        },

        invalidate(): void {},

        dispose(): void {
          clear();
        },
      };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          anchor: "center" as const,
        },
      }
    );
  };

  return { open, clear, requestRender };
}
