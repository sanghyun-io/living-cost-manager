import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Teal palette — hero/primary accent. Deeper, more saturated mid-band than the
// legacy ramp; the #0f766e era is replaced by a brighter #0f9e86 hero (index 6)
// with a luminous #2ecba6 used as the dark-mode primary (index 4).
const teal: MantineColorsTuple = [
  "#edfaf7", // 0
  "#d1f4ec", // 1
  "#a0e8d8", // 2
  "#66d9c0", // 3
  "#2ecba6", // 4 — dark-mode primary
  "#17b899", // 5
  "#0f9e86", // 6 — light-mode primary / hero
  "#0a806c", // 7
  "#075e50", // 8
  "#043d34"  // 9
];

// Rose palette for destructive/danger actions (#e11d48 at index 6).
const rose: MantineColorsTuple = [
  "#fff0f3",
  "#ffdce3",
  "#fbb8c5",
  "#f790a4",
  "#f46e88",
  "#f15877",
  "#e11d48", // 6 — legacy --rose
  "#c91740",
  "#b11038",
  "#990a30"
];

// Amber — used sparingly, ONLY for quiet delta chips (text-on-tint), never as a
// loud solid pill. Kept muted to preserve the calm mood.
const amber: MantineColorsTuple = [
  "#fff8eb",
  "#fdecc8",
  "#fadb98",
  "#f7c965",
  "#f5ba3d",
  "#f3ad22",
  "#e0950a", // 6
  "#b6770a", // 7
  "#8d5b0c",
  "#643f08"
];

export const theme = createTheme({
  primaryColor: "teal",
  // Dark mode uses the brighter teal (index 4) for contrast on the dark canvas.
  primaryShade: { light: 6, dark: 4 },
  colors: { teal, rose, amber },
  fontFamily:
    "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
  headings: {
    fontFamily: "'Pretendard Variable', Pretendard, sans-serif",
    fontWeight: "700"
  },
  fontSizes: { xs: "12px", sm: "13px", md: "14px", lg: "16px", xl: "20px" },
  radius: { xs: "8px", sm: "10px", md: "14px", lg: "20px", xl: "28px" },
  defaultRadius: "md",
  // Light-mode shadow scale with a subtle teal tint. Dark-mode shadows are
  // overridden in globals.css via scheme-scoped CSS vars (Mantine custom
  // `shadows` cannot vary per color scheme).
  shadows: {
    xs: "0 1px 3px rgba(0,0,0,0.07)",
    sm: "0 1px 4px rgba(15,158,134,0.06), 0 4px 16px rgba(0,0,0,0.06)",
    md: "0 2px 8px rgba(15,158,134,0.08), 0 8px 24px rgba(0,0,0,0.08)",
    lg: "0 4px 20px rgba(15,158,134,0.14), 0 12px 40px rgba(0,0,0,0.12)"
  }
});
