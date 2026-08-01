const webpack = require("@nativescript/webpack");
const { resolve } = require("path");

module.exports = (env) => {
	webpack.init(env);

	// Learn how to customize:
	// https://docs.nativescript.org/webpack

	// Bundle the top-level project docs so the Settings app's About section
	// can display them (see app/ui/dashboard/settings-menus.ts).
	for (const doc of ["README", "LICENSE", "PRIVACY"]) {
		webpack.Utils.addCopyRule({
			from: resolve(__dirname, doc),
			to: "about/",
		});
	}

	return webpack.resolveConfig();
};
