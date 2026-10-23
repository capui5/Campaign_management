sap.ui.define([
	"sap/ui/core/format/DateFormat",
	"com/luxasia/campaignmanagement/util/pricingService"
], function (DateFormat, pricingService) {
	"use strict";

	// Display texts for pricing condition rows, shared by the pricing screen and the campaign detail.
	// Used as XML view formatters, so `this` is the controller; it must provide _i18n(sKey, aArgs).
	return {
		// Condition validity dates are local calendar dates (see pricingService).
		date: function (oDate) {
			return oDate ? DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" }).format(oDate) : "";
		},

		// Description from ConditionsSet, else the FDD name.
		type: function (sType) {
			return sType ? (pricingService.conditionTypeText(sType) || this._i18n("Pricing_Type_" + sType)) : "";
		},

		combination: function (sComb) {
			return sComb ? sComb + " · " + this._i18n("Pricing_Comb_" + sComb) : "";
		},

		// Key values beyond Sales Org / DC / Campaign ID; "Campaign" when the combination has none.
		scope: function (sComb, sCustomer, sArticle, sBrand, sHierarchy) {
			var aParts = [];
			if (sBrand) {
				aParts.push(this._i18n("Pricing_Brand") + " " + sBrand + (sHierarchy ? " (" + sHierarchy + ")" : ""));
			}
			if (sCustomer) {
				aParts.push(this._i18n("Pricing_Customer") + " " + sCustomer);
			}
			if (sArticle) {
				aParts.push(this._i18n("Pricing_Article") + " " + sArticle);
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
