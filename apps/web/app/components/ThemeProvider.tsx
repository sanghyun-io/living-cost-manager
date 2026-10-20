"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { MantineProvider, type MantineColorsTuple } from '@mantine/core';
import type { UiTheme } from '@living-cost-manager/shared';
import { theme } from '../theme';
import { themeAccents } from '../lib/uiTheme';

const ThemeContext = createContext<(id: UiTheme) => void>(() => {});
export const useApplyUiTheme = () => useContext(ThemeContext);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<UiTheme>('jade');
  const dynamicTheme = useMemo(() => {
    const a = themeAccents[id];
    const brand: MantineColorsTuple = [a.soft, a.soft, a.dark, a.dark, a.dark, a.primary, a.primary, a.primary, a.hover, a.active];
    return { ...theme, colors: { ...theme.colors, brand }, primaryColor: 'brand', primaryShade: { light: 7 as const, dark: 7 as const }, autoContrast: false };
  }, [id]);
  return <ThemeContext.Provider value={setId}><MantineProvider theme={dynamicTheme} defaultColorScheme="light">{children}</MantineProvider></ThemeContext.Provider>;
}
