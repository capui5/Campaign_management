sap.ui.define([], function () {
	"use strict";

	// SAP ALPHA conversion of numeric keys (KUNNR, MATNR, KNUMH). The backends store them padded with
	// leading zeros ("0000005000", "000000099240011791"); the UI shows them without ("5000",
	// "99240011791") and pads them again when they are sent back. Values that are not purely numeric
	// (e.g. "SKU-01") are left as they are, as SAP conversion does.
	var LENGTH = {
		customer: 10, // KUNNR
		article: 18,  // MATNR
		recordNo: 10  // KNUMH
	};

	function _numeric(s) {
		return /^\d+$/.test(s);
	}

	return {
		LENGTH: LENGTH,

		// "0000005000" -> "5000" (display); "0000" -> "0".
		output: function (v) {
			var s = String(v === undefined || v === null ? "" : v).trim();
			return _numeric(s) ? s.replace(/^0+(?=\d)/, "") : s;
		},

		// "5000" -> "0000005000" for iLength 10 (payload); longer or non-numeric values are kept.
		input: function (v, iLength) {
			var s = String(v === undefined || v === null ? "" : v).trim();
			return _numeric(s) && iLength ? s.padStart(iLength, "0") : s;
		}
	};
});
