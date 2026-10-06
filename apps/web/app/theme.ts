import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Restrained teal for actions and meaningful data cues.
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
  primaryColor: "blue",
  autoContrast: true,
  // Both solid-action shades keep white button labels above AA contrast.
  primaryShade: { light: 7, dark: 6 },
  colors: { teal, rose, amber, blue: ["#eff5ff", "#dce8ff", "#b8d0ff", "#8db5ff", "#6798f5", "#487fe9", "#326ddd", "#245ac4", "#19479f", "#173a7a"] },
  fontFamily:
    "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
  headings: {
    fontFamily: "'Pretendard Variable', Pretendard, sans-serif",
    fontWeight: "700"
  },
  fontSizes: { xs: "12px", sm: "14px", md: "14px", lg: "16px", xl: "20px" },
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "10px", xl: "12px" },
  defaultRadius: "sm",
  shadows: {
    xs: "none",
    sm: "none",
    md: "0 4px 16px rgba(0,0,0,0.12)",
    lg: "0 8px 24px rgba(0,0,0,0.16)"
  }
});
