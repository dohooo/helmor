import { useMemo } from "react";

import type { HelmorTheme } from "../theme";
import { useHelmorTheme } from "../theme";

export function useThemedStyles<T>(createStyles: (theme: HelmorTheme) => T): T {
	const theme = useHelmorTheme();
	return useMemo(() => createStyles(theme), [createStyles, theme]);
}
