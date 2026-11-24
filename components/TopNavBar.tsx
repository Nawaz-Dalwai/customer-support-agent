"use client";
import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Moon, Sun, Check, BarChart3, MessageSquare } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { themes } from "@/styles/themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const themeColors = {
  neutral: "#000000",
  red: "#EF4444",
  violet: "#8B5CF6",
  blue: "#3B82F6",
  tangerine: "#F97316",
  emerald: "#10B981",
  amber: "#F59E0B",
} as const;

type ThemeName = keyof typeof themes;

const ColorCircle = ({
  themeName,
  isSelected,
}: {
  themeName: ThemeName;
  isSelected: boolean;
}) => (
  <div
    className="relative border flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
    style={{ backgroundColor: themeColors[themeName] }}
  >
    {isSelected && (
      <div className="absolute inset-0 flex items-center justify-center">
        <Check className="text-white" size={12} />
      </div>
    )}
  </div>
);

const TopNavBar = () => {
  const { theme, setTheme } = useTheme();
  const onInsights = usePathname() === "/insights";
  const [colorTheme, setColorTheme] = useState<ThemeName>("neutral");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedColorTheme = (localStorage.getItem("color-theme") ||
      "neutral") as ThemeName;
    setColorTheme(savedColorTheme);
    applyTheme(savedColorTheme, theme === "dark");
  }, [theme]);

  const applyTheme = (newColorTheme: ThemeName, isDark: boolean) => {
    const root = document.documentElement;
    const themeVariables = isDark
      ? themes[newColorTheme].dark
      : themes[newColorTheme].light;

    Object.entries(themeVariables).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value as string);
    });
  };

  const handleThemeChange = (newColorTheme: ThemeName) => {
    setColorTheme(newColorTheme);
    localStorage.setItem("color-theme", newColorTheme);
    applyTheme(newColorTheme, theme === "dark");
  };

  const handleModeChange = (mode: "light" | "dark" | "system") => {
    setTheme(mode);
    if (mode !== "system") {
      applyTheme(colorTheme, mode === "dark");
    }
  };

  if (!mounted) {
    return null;
  }

  return (
    <nav className="text-foreground p-4 flex justify-between items-center">
      <div className="flex flex-col gap-0.5 min-w-0">
        <h1 className="font-semibold text-lg leading-tight">
          Support Agent for Wix (Concept)
        </h1>
        <p className="text-xs text-muted-foreground">
          Unofficial concept demo. Not affiliated with or endorsed by Wix.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" asChild>
          <Link href={onInsights ? "/" : "/insights"} className="gap-1.5">
            {onInsights ? <MessageSquare className="h-4 w-4" /> : <BarChart3 className="h-4 w-4" />}
            <span className="hidden sm:inline">{onInsights ? "Chat" : "Insights"}</span>
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <ColorCircle themeName={colorTheme} isSelected={false} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(themes) as ThemeName[]).map((themeName) => (
              <DropdownMenuItem
                key={themeName}
                onClick={() => handleThemeChange(themeName)}
                className="flex items-center gap-2"
              >
                <ColorCircle
                  themeName={themeName}
                  isSelected={colorTheme === themeName}
                />
                {themeName.charAt(0).toUpperCase() + themeName.slice(1)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon">
              <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">Toggle theme</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleModeChange("light")}>
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleModeChange("dark")}>
              Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleModeChange("system")}>
              System
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
};

export default TopNavBar;
