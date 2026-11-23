sap.ui.define([
	"sap/ui/core/format/DateFormat",
	"com/luxasia/campaignmanagement/util/pricingService",
	"com/luxasia/campaignmanagement/util/alpha"
], function (DateFormat, pricingService, alpha) {
	"use strict";

	// Display texts for pricing condition rows, shared by the pricing screen and the campaign detail.
	// Used as XML view formatters, so `this` is the controller; it must provide _i18n(sKey, aArgs).
	return {
		// Condition validity dates are local calendar dates (see pricingService).
		date: function (oDate) {
			return oDate ? DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" }).format(oDate) : "";
		},

		// Customer / article / record number without leading zeros ("0000005000" -> "5000").
		alpha: function (s) {
			return alpha.output(s);
		},

		// Token "5000 - Name" (number only when the name is not known).
		alphaToken: function (sKey, sText) {
			var sNo = alpha.output(sKey);
			return sText && sText !== sKey ? sNo + " - " + sText : sNo;
		},

		// Description from CAP ConditionTypes.
		type: function (sType) {
			return sType ? pricingService.conditionTypeText(sType) : "";
		},

		// Description from CAP KeyCombinations.
		combination: function (sComb) {
			var sText = sComb ? pricingService.combinationText(sComb) : "";
			return sComb ? sComb + (sText ? " · " + sText : "") : "";
		},

		// Key values beyond Sales Org / DC / Campaign ID; "Campaign" when the combination has none.
		scope: function (sComb, sCustomer, sArticle, sBrand, sHierarchy) {
			var aParts = [];
			if (sBrand) {
				aParts.push(this._i18n("Pricing_Brand") + " " + sBrand + (sHierarchy ? " (" + sHierarchy + ")" : ""));
			}
			if (sCustomer) {
				aParts.push(this._i18n("Pricing_Customer") + " " + alpha.output(sCustomer));
			}
			if (sArticle) {
				aParts.push(this._i18n("Pricing_Article") + " " + alpha.output(sArticle));
			}
			return aParts.length ? aParts.join(", ") : (sComb ? this._i18n("Camp_Campaign") : "");
		},

		value: function (sRate, sUnit, sPricingUnit, sUom) {
			if (!sRate) {
				return "";
			}
			var sText = sRate + " " + (sUnit || "");
			return sPricingUnit && sUom ? sText + " / " + sPricingUnit + " " + sUom : sText;
		},

		validity: function (oFrom, oTo) {
			var fnDate = DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" });
			return (oFrom ? fnDate.format(oFrom) : "") + " → " + (oTo ? fnDate.format(oTo) : "");
		},

		status: function (sStatus) {
			return sStatus ? this._i18n("Pricing_Status_" + sStatus) : "";
		}
	};
});
