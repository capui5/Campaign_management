sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Sorter",
    "sap/ui/model/Filter",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, Sorter, Filter, MessageBox, DateFormat, campaignService, backNavGuard) {
    "use strict";

    // Campaign list (FDD §5 "Campaign list"): filter by campaign ID / description, country,
    // created by and created on; create, display, change, pricing; sorting and export. Laid out like the
    // Store Transfer inbox: overview counts, filter bar, then status tabs over one table.
    // The list is the app's start page: Back (shell or browser) asks "leave this page?" like the other
    // screens and then leaves the app.
    return Controller.extend("com.luxasia.campaignmanagement.controller.campaignList", {
        // Campaign dates are local calendar dates (see campaignService), so no SGT conversion here.
        formatDate: function (oDate) {
            return oDate ? DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" }).format(oDate) : "";
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
                var mCounts = { all: aCampaigns.length, Active: 0, Upcoming: 0, Expired: 0 };
                aCampaigns.forEach(function (c) {
                    mCounts[c.status] = (mCounts[c.status] || 0) + 1;
                });
                oViewModel.setProperty("/counts", mCounts);
                oViewModel.setProperty("/noDataText", that._i18n("Camp_No_Data"));
                that._applyTab();
            }).catch(function (oError) {
                oViewModel.setProperty("/counts", {});
                oViewModel.setProperty("/shown", 0);
                oViewModel.setProperty("/noDataText", oError.message);
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

        onSort: function () {
            var oBinding = this.byId("campTable").getBinding("items");
            this._bSortAsc = !this._bSortAsc;
            oBinding.sort(new Sorter("id", !this._bSortAsc));
        },

        onExport: function () {
            var that = this;
            var aRows = this.byId("campTable").getBinding("items").getContexts(0, Infinity).map(function (c) {
                var o = c.getObject();
                return Object.assign({}, o, { createdOnText: that.formatDate(o.createdOn) });
            });
            sap.ui.require(["sap/ui/export/Spreadsheet"], function (Spreadsheet) {
                var oSheet = new Spreadsheet({
                    workbook: {
                        columns: [
                            { label: that._i18n("Camp_Id"), property: "id" },
                            { label: that._i18n("Camp_Description"), property: "description" },
                            { label: that._i18n("Camp_Country"), property: "country" },
                            { label: that._i18n("Camp_Created_On"), property: "createdOnText" },
                            { label: that._i18n("Camp_Created_By"), property: "createdBy" },
                            { label: that._i18n("Camp_Status"), property: "status" }
                        ]
                    },
                    dataSource: aRows,
                    fileName: "Campaigns.xlsx"
                });
                oSheet.build().finally(function () {
                    oSheet.destroy();
                });
            });
        },

        _idFromEvent: function (oEvent) {
            return oEvent.getSource().getBindingContext("CampModel").getProperty("id");
        },

        _navTo: function (sRoute, oParams) {
            backNavGuard.disarm();
            this.getOwnerComponent().getRouter().navTo(sRoute, oParams || {});
        },

        // Leaving the start page goes back out of the app (launchpad), after the same popup as the
        // other screens.
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
        },

        // Toolbar "Pricing": opens the pricing screen for the first campaign shown in the table
        // (the campaign can be switched there).
        onPricingOpen: function () {
            var oItem = this.byId("campTable").getItems()[0];
            if (oItem) {
                this._navTo("campaignPricing", { campaignId: oItem.getBindingContext("CampModel").getProperty("id") });
            }
        },

        // Axxx key configuration (administrator function, FDD Addendum v1.1 §20).
        onPricingConfig: function () {
            this._navTo("pricingConfig");
        },

        onDeveloperGuide: function () {
            this._navTo("developerGuide");
        }
    });
});
