import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { SegmentedControl } from "~/components/ui";
import { useI18n } from "~/i18n";
import { DENSITY_COOKIE, type Density } from "~/i18n";

/**
 * Row density is an operator preference, not a screen setting.
 *
 * Same shape as the locale: resolved on the server from a cookie (so the first paint is
 * at the right height and hydration matches), overridden by a switch in the shell, and
 * reported by the switch so nobody has to guess why their table looks different from a
 * colleague's.
 *
 * Density is implemented as CSS variables on a container (`--density-row-py` and
 * friends in tokens.css), so it retunes every `.data-table`, `.list-row` and control
 * below it without a single component knowing that density exists.
 */

interface DensityValue {
  density: Density;
  setDensity: (next: Density) => void;
  /** Class for the container that should own the density variables. */
  densityClass: string;
}

const DensityContext = createContext<DensityValue>({
  density: "cozy",
  setDensity: () => undefined,
  densityClass: "",
});

export function densityClassFor(density: Density): string {
  return density === "cozy" ? "" : `density-${density}`;
}

export function DensityProvider({ initial, children }: { initial: Density; children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(initial);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    if (typeof document !== "undefined") {
      document.cookie = `${DENSITY_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
    }
  }, []);

  const value = useMemo<DensityValue>(
    () => ({ density, setDensity, densityClass: densityClassFor(density) }),
    [density, setDensity]
  );

  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function useDensity(): DensityValue {
  return useContext(DensityContext);
}

/** The switch itself. Lives in the shell header; usable on its own in the gallery. */
export function DensitySwitch() {
  const { density, setDensity } = useDensity();
  const { t } = useI18n();
  return (
    <SegmentedControl<Density>
      size="sm"
      ariaLabel={t("common.density.label")}
      value={density}
      onChange={setDensity}
      options={[
        { value: "compact", label: t("common.density.compact") },
        { value: "cozy", label: t("common.density.cozy") },
        { value: "roomy", label: t("common.density.roomy") },
      ]}
    />
  );
}
