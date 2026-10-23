sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "com/luxasia/campaignmanagement/util/campaignService",
  "com/luxasia/campaignmanagement/util/backNavGuard"
], (BaseController, JSONModel, MessageToast, campaignService, backNavGuard) => {
  "use strict";

  // Side navigation of the prototype: Overview & Flow / Campaigns / Pricing Conditions (application) and Axxx
  // Configuration / Developer Guide (administration). The entry of the current route is selected.
  var SIDE_NAV_ROUTE = {
      overview: "overview",
      campaignList: "campaignList",
      campaignCreate: "campaignList",
      campaignDetail: "campaignList",
      campaignPricing: "campaignPricing",
      pricingConfig: "pricingConfig",
      developerGuide: "developerGuide"
  };

  // Screens with a Back button in the app header; it runs the page's own onNavBack.
  var BACK_ROUTES = ["campaignCreate", "campaignDetail", "campaignPricing", "pricingConfig", "developerGuide"];

  // Screens with maintainable data ask before they are left, like their back button.
  var CONFIRM_ROUTES = ["campaignCreate", "campaignDetail", "campaignPricing", "pricingConfig"];

  return BaseController.extend("com.luxasia.campaignmanagement.controller.App", {
      onInit() {
          this.getView().setModel(new JSONModel({ showBack: false }), "shell");
          this.getOwnerComponent().getRouter().attachRouteMatched(this._onRouteMatched, this);
      },

      _i18n(sKey) {
          return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey);
      },

      _onRouteMatched(oEvent) {
          var sRoute = oEvent.getParameter("name");
          var oArgs = oEvent.getParameter("arguments") || {};
          this._sRoute = sRoute;
          this.getView().getModel("shell").setProperty("/showBack", BACK_ROUTES.indexOf(sRoute) !== -1);
          // Pricing Conditions in the side navigation reopens the campaign last worked on.
          if (oArgs.campaignId) {
              this._sCampaignId = oArgs.campaignId;
          }
          this._selectSideNav();
      },

      _selectSideNav() {
          var sNav = SIDE_NAV_ROUTE[this._sRoute];
          var oList = this.byId("sideNav");
          oList.getItems().forEach(function (oItem) {
              if (oItem.data("route") === sNav) {
                  oList.setSelectedItem(oItem);
              }
          });
      },

      // Without a campaign worked on yet, the first one of the list (newest ID, as in the table).
      _pricingCampaignId() {
          if (this._sCampaignId) {
              return this._sCampaignId;
          }
          var oModel = campaignService.getModel && campaignService.getModel();
          var aIds = ((oModel && oModel.getProperty("/campaigns")) || []).map(function (o) { return o.id; }).sort();
          return aIds.length ? aIds[aIds.length - 1] : "";
      },

      onNavBack() {
          var oPage = this.byId("app").getCurrentPage();
          var oController = oPage && oPage.getController && oPage.getController();
          if (oController && oController.onNavBack) {
              oController.onNavBack();
          }
      },

      onSideNavPress(oEvent) {
          var sTarget = oEvent.getParameter("listItem").data("route");
          var oRouter = this.getOwnerComponent().getRouter();
          if (SIDE_NAV_ROUTE[this._sRoute] === sTarget && this._sRoute !== "campaignDetail" && this._sRoute !== "campaignCreate") {
              return;
          }
          if (CONFIRM_ROUTES.indexOf(this._sRoute) !== -1 && !confirm(this._i18n("sure_leave_page"))) {
              // Keep the entry of the screen that stays open selected.
              this._selectSideNav();
              return;
          }
          backNavGuard.disarm();
          if (sTarget === "campaignPricing") {
              var sId = this._pricingCampaignId();
              if (!sId) {
                  MessageToast.show(this._i18n("Nav_Select_Campaign"));
                  oRouter.navTo("campaignList");
                  return;
              }
              oRouter.navTo("campaignPricing", { campaignId: sId });
              return;
          }
          oRouter.navTo(sTarget);
      }
  });
});
