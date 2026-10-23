sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/pricingService",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, MessageBox, campaignService, pricingService, backNavGuard) {
    "use strict";

    // Overview & Flow (prototype dashboard): campaign counts, configured key combinations
    // (active mappings with a condition table number), the end-to-end process and shortcuts.
    // Route: "" (start page of the app).
    return Controller.extend("com.luxasia.campaignmanagement.controller.overview", {
        onInit: function () {
            this.getView().setModel(new JSONModel({ busy: false, campaigns: 0, active: 0, configured: 0, combinations: 0 }), "overview");
            this.getOwnerComponent().getRouter().getRoute("overview").attachPatternMatched(this._load, this);
        },

        _load: function () {
            var oModel = this.getView().getModel("overview");
            var oComponent = this.getOwnerComponent();
            oModel.setProperty("/busy", true);
            Promise.all([campaignService.init(oComponent), pricingService.init(oComponent)]).then(function () {
                return campaignService.search({});
            }).then(function (aCampaigns) {
                var aConfigs = pricingService.getModel().getProperty("/configs") || [];
                oModel.setProperty("/campaigns", aCampaigns.length);
                oModel.setProperty("/active", aCampaigns.filter(function (c) { return c.status === "Active"; }).length);
                oModel.setProperty("/combinations", aConfigs.length);
                oModel.setProperty("/configured", aConfigs.filter(function (c) { return c.active && c.tableNo; }).length);
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        _navTo: function (sRoute, oParams) {
            backNavGuard.disarm();
            this.getOwnerComponent().getRouter().navTo(sRoute, oParams || {});
        },

        onRefresh: function () {
            this._load();
        },

        onCreate: function () {
            this._navTo("campaignCreate");
        },

        // Pricing of the newest campaign; the campaign can be switched on the pricing screen.
        onOpenPricing: function () {
            var aIds = (campaignService.getModel().getProperty("/campaigns") || []).map(function (c) { return c.id; }).sort();
            this._navTo(aIds.length ? "campaignPricing" : "campaignList", aIds.length ? { campaignId: aIds[aIds.length - 1] } : {});
        }
    });
});
