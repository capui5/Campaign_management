sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, Filter, MessageBox, DateFormat, campaignService, backNavGuard) {
    "use strict";

    // Campaign list (FDD §5 "Campaign list"): filter by campaign ID / description, country,
    // created by and created on; create, display, change and pricing. Laid out like the
    // Store Transfer inbox: overview counts, filter bar, then status tabs over one table.
    // Route: campaigns (the Overview is the start page). Back (shell or browser) asks "leave this page?"
    // like the other screens and then goes back in the history.
    return Controller.extend("com.luxasia.campaignmanagement.controller.campaignList", {
        // Campaign dates are local calendar dates (see campaignService), so no SGT conversion here.
        formatDate: function (oDate) {
            return oDate ? DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" }).format(oDate) : "";
        },

        // Overall validity of the campaign's pricing conditions: earliest Valid From - latest Valid To,
        // e.g. "01 Nov 2026 – 30 Nov 2026".
        formatPricingValidity: function (oFrom, oTo, iCount) {
            if (!iCount) {
                return "";
            }
            var oFmt = DateFormat.getDateInstance({ pattern: "dd MMM yyyy" });
            var sTo = oTo ? oFmt.format(oTo) : this._i18n("Camp_Open_Ended");
            return (oFrom ? oFmt.format(oFrom) : "…") + " – " + sTo;
        },

        // "Ends in 20 days · 3 conditions", "Starts tomorrow · 1 condition", "Ended 41 days ago · ...".
        formatValidityHint: function (sStatus, oTo, oNextFrom, iCount) {
            if (iCount === null || iCount === undefined) {
                return "";
            }
            if (!iCount) {
                return this._i18n("Camp_No_Conditions");
            }
            var sWhen = "";
            if (sStatus === "Active") {
                sWhen = oTo ? this._i18n("Camp_Ends", [this._relDays(oTo)]) : this._i18n("Camp_No_End");
            } else if (sStatus === "Upcoming" && oNextFrom) {
                sWhen = this._i18n("Camp_Starts", [this._relDays(oNextFrom)]);
            } else if (sStatus === "Expired" && oTo) {
                sWhen = this._i18n("Camp_Ended", [this._relDays(oTo)]);
            }
            var sCount = this._i18n(iCount === 1 ? "Camp_Condition_One" : "Camp_Condition_Many", [iCount]);
            return sWhen ? sWhen + " · " + sCount : sCount;
        },

        _today: function () {
            var oToday = new Date();
            oToday.setHours(0, 0, 0, 0);
            return oToday;
        },

        // "today", "tomorrow", "yesterday", "in 5 days", "5 days ago".
        _relDays: function (oDate) {
            var iDays = Math.round((oDate - this._today()) / 86400000);
            if (iDays === 0) {
                return this._i18n("Camp_Rel_Today");
            }
            if (iDays === 1) {
                return this._i18n("Camp_Rel_Tomorrow");
            }
            if (iDays === -1) {
                return this._i18n("Camp_Rel_Yesterday");
            }
            return this._i18n(iDays > 0 ? "Camp_Rel_In" : "Camp_Rel_Ago", [Math.abs(iDays)]);
        },

        formatStatusKey: function (sStatus) {
            return (sStatus || "").replace(/\s/g, "");
        },

        formatCreatedBy: function (sUser) {
            return sUser ? this._i18n("Camp_By", [sUser]) : "";
        },

        formatStatusIcon: function (sStatus) {
            return {
                "Active": "sap-icon://sys-enter-2",
                "Upcoming": "sap-icon://future",
                "Expired": "sap-icon://history",
                "No Pricing": "sap-icon://less"
            }[sStatus] || "";
        },

        onInit: function () {
            this.getView().setModel(new JSONModel({ busy: false, shown: 0, noDataText: "", tab: "all", counts: {} }), "view");
            this.getOwnerComponent().getRouter().getRoute("campaignList").attachPatternMatched(this._onRouteMatched, this);
        },

        _i18n: function (sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _onRouteMatched: function () {
            var that = this;
            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/busy", true);
            backNavGuard.arm(this);
            campaignService.init(this.getOwnerComponent()).then(function () {
                that.getView().setModel(campaignService.getModel(), "CampModel");
                // First visit shows all countries; the country filter applies only when selected.
                return that._load(that._oCriteria || that._readFilterControls());
            }).catch(function (oError) {
                oViewModel.setProperty("/busy", false);
                MessageBox.error(oError.message);
            });
        },

        _load: function (oCriteria) {
            var that = this;
            var oViewModel = this.getView().getModel("view");
            this._oCriteria = oCriteria;
            oViewModel.setProperty("/busy", true);
            return campaignService.search(oCriteria).then(function (aCampaigns) {
                that._showCampaigns(aCampaigns);
            }).catch(function (oError) {
                oViewModel.setProperty("/counts", {});
                oViewModel.setProperty("/shown", 0);
                oViewModel.setProperty("/noDataText", oError.message);
                MessageBox.error(oError.message);
            }).finally(function () {
                oViewModel.setProperty("/busy", false);
            });
        },

        // Status comes from the validity of each campaign's pricing conditions (campaignService).
        // Counts of the loaded campaigns (20 per page, API §4.1) for the status tabs.
        _showCampaigns: function (aCampaigns) {
            var oViewModel = this.getView().getModel("view");
            // Keys without spaces ("No Pricing" -> NoPricing) so the view can bind them.
            var mCounts = { all: aCampaigns.length, Active: 0, Upcoming: 0, Expired: 0, NoPricing: 0 };
            aCampaigns.forEach(function (c) {
                var sKey = c.status.replace(/\s/g, "");
                mCounts[sKey] = (mCounts[sKey] || 0) + 1;
            });
            oViewModel.setProperty("/counts", mCounts);
            oViewModel.setProperty("/noDataText", this._i18n("Camp_No_Data"));
            this._applyTab();
        },

        // "More": the next 20 campaigns ($skip = campaigns read so far, API §4.1).
        onMore: function () {
            var that = this;
            var oViewModel = this.getView().getModel("view");
            oViewModel.setProperty("/busy", true);
            campaignService.searchMore().then(function (aCampaigns) {
                that._showCampaigns(aCampaigns);
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oViewModel.setProperty("/busy", false);
            });
        },

        // Status tabs filter the loaded campaigns on the client, like the Store Transfer tabs.
        _applyTab: function () {
            var oViewModel = this.getView().getModel("view");
            var sTab = oViewModel.getProperty("/tab");
            var oBinding = this.byId("campTable").getBinding("items");
            oBinding.filter(sTab === "all" ? [] : [new Filter("status", "EQ", sTab)]);
            oViewModel.setProperty("/shown", oBinding.getLength());
        },

        onTabSelect: function () {
            this._applyTab();
        },

        _readFilterControls: function () {
            var oDate = this.byId("fltCreatedOn");
            return {
                campaign: (this.byId("fltCampaign").getValue() || "").trim(),
                // No country selected means all countries.
                countries: this.byId("fltCountry").getSelectedKeys(),
                createdBy: (this.byId("fltCreatedBy").getValue() || "").trim(),
                from: oDate.getDateValue(),
                to: oDate.getSecondDateValue()
            };
        },

        onSearch: function () {
            this._load(this._readFilterControls());
        },

        // Clear resets the filters and the status tab, so the table shows the campaigns of all countries.
        onClearFilters: function () {
            this.byId("fltCampaign").setValue("");
            this.byId("fltCountry").setSelectedKeys([]);
            this.byId("fltCreatedBy").setValue("");
            this.byId("fltCreatedOn").setValue("");
            this.getView().getModel("view").setProperty("/tab", "all");
            this._load(this._readFilterControls());
        },

        _idFromEvent: function (oEvent) {
            return oEvent.getSource().getBindingContext("CampModel").getProperty("id");
        },

        _navTo: function (sRoute, oParams) {
            backNavGuard.disarm();
            this.getOwnerComponent().getRouter().navTo(sRoute, oParams || {});
        },

        // Back goes to the previous history entry (Overview, or the launchpad on a deep link), after
        // the same popup as the other screens.
        handleBackButton: function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            if (!confirm(this._i18n("sure_leave_page"))) {
                backNavGuard.rearm();
                return;
            }
            backNavGuard.disarm();
            window.history.go(-1);
        },

        onCreate: function () {
            this._navTo("campaignCreate");
        },

        // Display opens the campaign read-only, Change opens it in edit mode (rows themselves are
        // not clickable, so the two buttons decide the mode).
        onDisplay: function (oEvent) {
            this._navTo("campaignDetail", { campaignId: this._idFromEvent(oEvent), "?query": { mode: "display" } });
        },

        onChange: function (oEvent) {
            this._navTo("campaignDetail", { campaignId: this._idFromEvent(oEvent), "?query": { mode: "edit" } });
        },

        // Pricing conditions of the campaign (prototype "Pricing" row action).
        onPricing: function (oEvent) {
            this._navTo("campaignPricing", { campaignId: this._idFromEvent(oEvent) });
        }
    });
});
