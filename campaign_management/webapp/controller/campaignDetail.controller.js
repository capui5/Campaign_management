sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/ui/core/format/DateFormat",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/pricingService",
    "com/luxasia/campaignmanagement/util/pricingFormatter",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, MessageBox, DateFormat, campaignService, pricingService, pricingFormatter, backNavGuard) {
    "use strict";

    // Campaign create / change / display (FDD §4.1, §4.3, §5 "General tab", "Pricing tab" and "History tab").
    // Routes: campaignCreate (new) and campaignDetail/{campaignId}: the list's Display button opens it
    // read-only, its Change button adds ?mode=edit to open it in edit mode.
    // Campaign ID and creation metadata are read-only; only description and country are editable.
    // The Pricing Conditions section lists the condition records linked to a saved campaign; they are
    // maintained on the campaignPricing screen.
    return Controller.extend("com.luxasia.campaignmanagement.controller.campaignDetail", {
        // Campaign dates are local calendar dates (see campaignService), so no SGT conversion here.
        formatDate: function (oDate) {
            return oDate ? DateFormat.getDateInstance({ pattern: "dd-MM-yyyy" }).format(oDate) : "";
        },

        onInit: function () {
            this.getView().setModel(new JSONModel(this._emptyState()), "camp");
            var oRouter = this.getOwnerComponent().getRouter();
            oRouter.getRoute("campaignCreate").attachPatternMatched(this._onCreateMatched, this);
            oRouter.getRoute("campaignDetail").attachPatternMatched(this._onDetailMatched, this);
        },

        _i18n: function (sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _emptyState: function () {
            return {
                isNew: true,
                edit: true,
                busy: false,
                descriptionMax: campaignService.DESCRIPTION_MAX,
                data: { id: "", description: "", country: "" },
                original: {},
                display: {},
                history: [],
                conditions: [],
                pricing: { total: 0, saved: 0, open: 0 },
                state: { description: "None", country: "None" },
                stateText: { description: "", country: "" }
            };
        },

        // Copy with its own Date objects, so editing a date picker does not change /original.
        _copy: function (o) {
            var oCopy = Object.assign({}, o);
            ["validFrom", "validTo", "createdOn", "changedOn"].forEach(function (k) {
                oCopy[k] = o[k] ? new Date(o[k].getTime()) : null;
            });
            return oCopy;
        },

        _model: function () {
            return this.getView().getModel("camp");
        },

        _init: function () {
            var that = this;
            return campaignService.init(this.getOwnerComponent()).then(function () {
                that.getView().setModel(campaignService.getModel(), "CampModel");
            });
        },

        _onCreateMatched: function () {
            var that = this;
            var oModel = this._model();
            oModel.setData(this._emptyState());
            oModel.setProperty("/busy", true);
            this._init().then(function () {
                // §4.1: country defaults from the authenticated user; may be changed if authorized.
                oModel.setProperty("/data/country", campaignService.getDefaultCountry());
                that._refreshDisplay();
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
            this._refreshDisplay();
            backNavGuard.arm(this);
        },

        _onDetailMatched: function (oEvent) {
            var oArgs = oEvent.getParameter("arguments") || {};
            var oQuery = oArgs["?query"] || {};
            var oModel = this._model();
            oModel.setData(Object.assign(this._emptyState(), { isNew: false, edit: oQuery.mode === "edit" }));
            this._sPricingFor = oArgs.campaignId;
            this._loadCampaign(oArgs.campaignId);
            this._loadPricing(oArgs.campaignId);
            backNavGuard.arm(this);
        },

        _showCampaign: function (oCampaign) {
            var oModel = this._model();
            oModel.setProperty("/data", this._copy(oCampaign));
            oModel.setProperty("/original", oCampaign);
            oModel.setProperty("/history", this._history(oCampaign));
            this._refreshDisplay();
        },

        // Opened from the list: show the selected row as loaded there, no extra backend call.
        // Read from the backend only when it is not in the list (opened by direct link).
        _loadCampaign: function (sId) {
            var that = this;
            var oModel = this._model();
            var oCached = campaignService.getCached(sId);
            if (oCached) {
                this._showCampaign(oCached);
                return this._init().catch(function (oError) {
                    MessageBox.error(oError.message);
                });
            }
            oModel.setProperty("/busy", true);
            return this._init().then(function () {
                return campaignService.get(sId);
            }).then(function (oCampaign) {
                that._showCampaign(oCampaign);
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        // Condition records linked to the campaign (S/4 records plus this session's drafts).
        _loadPricing: function (sId) {
            var that = this;
            var oModel = this._model();
            return pricingService.init(this.getOwnerComponent()).then(function () {
                return pricingService.loadConditions(sId);
            }).then(function (aRows) {
                // Ignore a late answer for a campaign that is no longer shown.
                if (oModel.getProperty("/isNew") || that._sPricingFor !== sId) {
                    return;
                }
                that._showPricing(aRows);
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            });
        },

        _showPricing: function (aRows) {
            var that = this;
            var oModel = this._model();
            var nSaved = aRows.filter(function (o) { return o.status === pricingService.STATUS.SAVED; }).length;
            oModel.setProperty("/conditions", aRows.map(function (o) {
                return Object.assign({}, o, {
                    combinationText: pricingFormatter.combination.call(that, o.combination),
                    scopeText: pricingFormatter.scope.call(that, o.combination, o.customer, o.article, o.brand, o.hierarchy),
                    valueText: pricingFormatter.value(o.rate, o.rateUnit, o.pricingUnit, o.uom),
                    validityText: pricingFormatter.validity(o.validFrom, o.validTo),
                    statusText: pricingFormatter.status.call(that, o.status)
                });
            }));
            oModel.setProperty("/pricing", { total: aRows.length, saved: nSaved, open: aRows.length - nSaved });
            var oCampaign = oModel.getProperty("/original");
            if (oCampaign && oCampaign.id) {
                oModel.setProperty("/history", this._history(oCampaign));
            }
        },

        // Campaign ID text; a new campaign shows that S/4 generates it on save (§10).
        _refreshDisplay: function () {
            var oModel = this._model();
            oModel.setProperty("/display", {
                id: oModel.getProperty("/isNew") ? this._i18n("Camp_Id_Auto") : oModel.getProperty("/data/id")
            });
        },

        // Audit events available on the campaign record itself; detailed old/new values come from
        // S/4 change documents once the backend exposes them.
        _history: function (o) {
            var aEvents = [];
            if (o.createdOn || o.createdBy) {
                aEvents.push({ event: this._i18n("Camp_History_Created"), user: o.createdBy, date: o.createdOn });
            }
            if (o.changedOn || o.changedBy) {
                aEvents.push({ event: this._i18n("Camp_History_Changed"), user: o.changedBy, date: o.changedOn });
            }
            var that = this;
            (this._model().getProperty("/conditions") || []).forEach(function (c) {
                if (c.status === pricingService.STATUS.SAVED) {
                    aEvents.push({
                        event: that._i18n("Camp_History_Pricing", [c.conditionType, c.combination, c.recordNo]),
                        user: c.createdBy,
                        date: c.createdOn
                    });
                }
            });
            return aEvents;
        },

        _clearStates: function () {
            var oModel = this._model();
            oModel.setProperty("/state", { description: "None", country: "None" });
            oModel.setProperty("/stateText", { description: "", country: "" });
        },

        _showMessages: function (aMsg) {
            var oModel = this._model();
            this._clearStates();
            aMsg.forEach(function (m) {
                if (oModel.getProperty("/state/" + m.field)) {
                    oModel.setProperty("/state/" + m.field, "Error");
                    oModel.setProperty("/stateText/" + m.field, m.text);
                }
            });
            MessageBox.error(aMsg.map(function (m) { return m.text; }).join("\n"));
        },

        onFieldChange: function (oEvent) {
            var sField = oEvent.getSource() === this.byId("campCountry") ? "country" : "description";
            this._model().setProperty("/state/" + sField, "None");
            this._model().setProperty("/stateText/" + sField, "");
        },

        // Display -> change mode on the same screen.
        onEditMode: function () {
            this._clearStates();
            this._model().setProperty("/edit", true);
        },

        _hasChanges: function () {
            var o = this._model().getProperty("/data");
            var oOrig = this._model().getProperty("/original");
            // Only description and country are saved.
            return (o.description || "").trim() !== (oOrig.description || "") || o.country !== oOrig.country;
        },

        // Cancel leaves the screen (after the leave-page popup), for create and change alike.
        onCancel: function () {
            this.handleBackButton();
        },

        onSave: function () {
            var that = this;
            var oModel = this._model();
            var oDraft = oModel.getProperty("/data");
            var bNew = oModel.getProperty("/isNew");
            var aMsg = bNew ? campaignService.validate(oDraft) :
                campaignService.validate(oDraft, oModel.getProperty("/original/id"));
            if (aMsg.length) {
                this._showMessages(aMsg);
                return;
            }
            if (!bNew && !this._hasChanges()) {
                MessageBox.information(this._i18n("Camp_No_Changes"));
                return;
            }
            this._clearStates();
            oModel.setProperty("/busy", true);
            if (oModel.getProperty("/isNew")) {
                campaignService.create(oDraft).then(function (oCampaign) {
                    // On OK go back to the campaign list, which reloads its table on arrival.
                    MessageBox.success(that._i18n("Camp_Created_Msg", [oCampaign.id]), {
                        onClose: function () {
                            that._leave();
                        }
                    });
                }).catch(function (oError) {
                    that._showMessages(oError.messages || [{ text: oError.message }]);
                }).finally(function () {
                    oModel.setProperty("/busy", false);
                });
                return;
            }
            var sId = oModel.getProperty("/original/id");
            campaignService.update(sId, oDraft, oModel.getProperty("/original")).then(function (oUpdated) {
                oModel.setProperty("/edit", false);
                that._showCampaign(oUpdated);
                // On OK go back to the campaign list, which reloads its table on arrival.
                MessageBox.success(that._i18n("Camp_Updated_Msg", [sId]), {
                    onClose: function () {
                        that._leave();
                    }
                });
            }).catch(function (oError) {
                that._showMessages(oError.messages || [{ text: oError.message }]);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        // Opens the pricing screen of this campaign; unsaved campaign changes need the leave popup.
        onMaintainPricing: function () {
            var that = this;
            var oModel = this._model();
            var fnGo = function () {
                backNavGuard.disarm();
                that.getOwnerComponent().getRouter().navTo("campaignPricing", {
                    campaignId: oModel.getProperty("/original/id"),
                    "?query": { from: "detail" }
                });
            };
            if (!oModel.getProperty("/edit") || !this._hasChanges()) {
                fnGo();
                return;
            }
            MessageBox.confirm(this._i18n("sure_leave_page"), {
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        fnGo();
                    }
                }
            });
        },

        onBackToList: function () {
            this.handleBackButton();
        },

        onNavBack: function () {
            this.handleBackButton();
        },

        handleBackButton: function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            // Same "leave this page?" popup as the other screens (header back, browser back,
            // Back to Campaigns, and Cancel on a new campaign).
            if (!confirm(this._i18n("sure_leave_page"))) {
                backNavGuard.rearm();
                return;
            }
            this._leave();
        },

        _leave: function () {
            backNavGuard.disarm();
            this._model().setData(this._emptyState());
            this.getOwnerComponent().getRouter().navTo("campaignList", {}, true);
        }
    });
});
