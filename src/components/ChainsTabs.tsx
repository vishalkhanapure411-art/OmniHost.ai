import { useRouter } from "@tanstack/react-router";

import { Tabs, type TabItem } from "~/components/tabs";

/**
 * The App-layer tab bar, shared by `/chains` and `/chains/onboard`.
 *
 * Before this, "Onboard a chain" appeared **three times on one screen** — a header
 * button, an explainer card's title, and that card's own button — and the card also
 * promised a three-step flow that the form below it did not have. The tab bar is the
 * single home for that verb: the browse screen browses, the second tab is the form, and
 * the count on the first tab is the number of chains in scope.
 *
 * The route owns the value (`onChange` navigates), so both tabs are real URLs and the
 * back button works.
 */
export function ChainsTabs({ active, count }: { active: "list" | "onboard"; count?: number }) {
  const router = useRouter();

  const items: TabItem[] = [
    { value: "list", label: "chains.tab.list", badge: count },
    { value: "onboard", label: "chains.tab.onboard" },
  ];

  return (
    <Tabs
      idBase="chains-views"
      ariaLabel="chains.tabs.aria"
      value={active}
      items={items}
      onChange={(next) => {
        if (next === "onboard") {
          void router.navigate({ to: "/chains/onboard" });
          return;
        }
        void router.navigate({ to: "/chains" });
      }}
    />
  );
}
