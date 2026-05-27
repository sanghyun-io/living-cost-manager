import { createTheme, type MantineColorsTuple } from "@mantine/core";

// Teal palette anchored on the legacy accent (#0f766e at index 6) and
// accent-strong (#134e4a) toward the darker end. Used as primaryColor.
const teal: MantineColorsTuple = [
  "#eafaf6",
  "#d4f0e8",
  "#a7e1d0",
  "#76d1b6",
  "#4fc4a1",
  "#36bc94",
  "#0f766e", // 6 — legacy --accent
  "#0d655e",
  "#134e4a", // 8 — legacy --accent-strong
  "#0a3d3a"
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

export const theme = createTheme({
  primaryColor: "teal",
  primaryShade: { light: 6, dark: 5 },
  colors: { teal, rose },
  fontFamily: 'Arial, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  fontSizes: { md: "14px" },
  radius: { sm: "8px" },
  defaultRadius: "sm"
});
