sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/Label",
    "sap/m/DatePicker",
    "sap/m/VBox",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/pricingService",
    "com/luxasia/campaignmanagement/util/pricingFormatter",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, Filter, MessageBox, MessageToast, Dialog, Button, Label, DatePicker, VBox,
    campaignService, pricingService, pricingFormatter, backNavGuard) {
    "use strict";

    // Pricing conditions of a saved campaign (FDD §4.2, §5 "Pricing tab header", "Dynamic key fields",
    // "Condition value", "Condition grid"). Laid out like the prototype: 1 campaign + condition type,
    // 2 key combination, 3 condition details, 4 the campaign's records with Validate / Save to S/4.
    // Route: campaignPricing/{campaignId}, ?from=detail when opened from the campaign detail (back
    // returns there, else to the list). Draft rows live in pricingService for the session, so
    // leaving this screen does not lose them.
    var FIELDS = ["conditionType", "combination", "salesOrg", "distChannel", "customer", "article", "hierarchy",
        "brand", "validFrom", "validTo", "rate", "rateUnit", "pricingUnit", "uom"];

    return Controller.extend("com.luxasia.campaignmanagement.controller.pricingConditions", {
        formatDate: pricingFormatter.date,
        formatType: pricingFormatter.type,
        formatCombination: pricingFormatter.combination,
        formatScope: pricingFormatter.scope,
        formatValue: pricingFormatter.value,
        formatValidity: pricingFormatter.validity,
        formatStatus: pricingFormatter.status,

        onInit: function () {
            this.getView().setModel(new JSONModel(this._emptyState()), "pricing");
            this.getOwnerComponent().getRouter().getRoute("campaignPricing").attachPatternMatched(this._onRouteMatched, this);
        },

        _i18n: function (sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _model: function () {
            return this.getView().getModel("pricing");
        },

        _emptyState: function () {
            var mState = {};
            var mText = {};
            FIELDS.forEach(function (f) {
                mState[f] = "None";
                mText[f] = "";
            });
            return {
                busy: false,
                campaignId: "",
                country: "",
                campaigns: [],
                types: [],
                combinations: [],
                combinationIndex: -1,
                draft: {},
                kind: "percent",
                rateLabel: "",
                fields: { customer: false, article: false, brand: false },
                tableText: "",
                configured: false,
                shown: 0,
                state: mState,
                stateText: mText
            };
        },

        _onRouteMatched: function (oEvent) {
            var that = this;
            var oArgs = oEvent.getParameter("arguments");
            var sId = oArgs.campaignId;
            this._sFrom = (oArgs["?query"] || {}).from || "";
            var oModel = this._model();
            var sType = oModel.getProperty("/draft/conditionType");
            oModel.setData(this._emptyState());
            oModel.setProperty("/campaignId", sId);
            oModel.setProperty("/busy", true);
            var oComponent = this.getOwnerComponent();
            Promise.all([campaignService.init(oComponent), pricingService.init(oComponent)]).then(function () {
                that.getView().setModel(pricingService.getModel(), "PricingModel");
                that._filterRecords(sId);
                // Brand value help is optional: typed brands are validated by S/4.
                pricingService.loadBrands(campaignService.getStoreId());
                return Promise.all([that._campaign(sId), pricingService.loadConditions(sId), pricingService.loadConditionTypes()]);
            }).then(function (aResults) {
                var oCampaign = aResults[0];
                oModel.setProperty("/country", oCampaign.country);
                oModel.setProperty("/campaigns", that._campaignList(oCampaign));
                // Condition types from ConditionsSet (backend description, else the FDD name).
                var aTypes = aResults[2];
                oModel.setProperty("/types", aTypes.map(function (t) {
                    return { key: t.key, text: t.text || that._i18n("Pricing_Type_" + t.key) };
                }));
                var bKnown = aTypes.some(function (t) { return t.key === sType; });
                that._resetDraft(bKnown ? sType : aTypes[0].key);
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
            backNavGuard.arm(this);
        },

        // The campaign as loaded in the list, else read from the backend (direct link).
        _campaign: function (sId) {
            return Promise.resolve(campaignService.getCached(sId) || campaignService.get(sId));
        },

        // Campaign picker: the list's campaigns, plus this one when opened by direct link.
        _campaignList: function (oCurrent) {
            var aList = (campaignService.getModel().getProperty("/campaigns") || []).map(function (c) {
                return { id: c.id, description: c.description };
            });
            if (!aList.some(function (c) { return c.id === oCurrent.id; })) {
                aList.unshift({ id: oCurrent.id, description: oCurrent.description });
            }
            return aList;
        },

        _filterRecords: function (sId) {
            var oBinding = this.byId("pricingTableRecords").getBinding("items");
            if (oBinding) {
                oBinding.filter([new Filter("campaignId", "EQ", sId)]);
            }
        },

        onRecordsUpdated: function (oEvent) {
            this._model().setProperty("/shown", oEvent.getSource().getBinding("items").getLength());
        },

        // ------------------------------------------------------------ draft

        // New draft for the condition type (keeps the last one), with its default combination.
        // Only the campaign is prefilled; the user enters every condition detail.
        _resetDraft: function (sType) {
            var oModel = this._model();
            var oDraft = this._blankDetails(pricingService.newDraft(oModel.getProperty("/campaignId"), oModel.getProperty("/country"), sType));
            oModel.setProperty("/draft", oDraft);
            this._applyType();
        },

        // Empties the condition details of a draft; campaign, condition type and combination stay.
        // Percentages keep % as their unit, which is not editable.
        _blankDetails: function (oDraft) {
            var bPercent = pricingService.CONDITION_TYPES[oDraft.conditionType].kind === "percent";
            return Object.assign({}, oDraft, {
                salesOrg: "",
                distChannel: "",
                customer: "",
                article: "",
                hierarchy: "",
                brand: "",
                rate: "",
                rateUnit: bPercent ? pricingService.PERCENT : "",
                pricingUnit: "",
                uom: "",
                validFrom: null,
                validTo: null
            });
        },

        // Combination list, labels and visible key fields follow the condition type.
        _applyType: function () {
            var that = this;
            var oModel = this._model();
            var sType = oModel.getProperty("/draft/conditionType");
            var sKind = pricingService.CONDITION_TYPES[sType].kind;
            var aCombs = pricingService.combinationsFor(sType);
            var sComb = oModel.getProperty("/draft/combination");
            if (aCombs.indexOf(sComb) === -1) {
                sComb = pricingService.defaultCombination(sType);
                oModel.setProperty("/draft/combination", sComb);
            }
            oModel.setProperty("/kind", sKind);
            oModel.setProperty("/rateLabel", this._i18n(sKind === "percent" ? "Pricing_Rate_Percent" :
                sKind === "price" ? "Pricing_Rate_Price" : "Pricing_Rate_Amount"));
            oModel.setProperty("/combinations", aCombs.map(function (k) {
                return { key: k, text: that._i18n("Pricing_Comb_" + k) };
            }));
            oModel.setProperty("/combinationIndex", aCombs.indexOf(sComb));
            this._applyCombination();
        },

        _applyCombination: function () {
            var oModel = this._model();
            var sType = oModel.getProperty("/draft/conditionType");
            var sComb = oModel.getProperty("/draft/combination");
            var aFields = sComb ? pricingService.COMBINATIONS[sComb].fields : [];
            oModel.setProperty("/fields", {
                customer: aFields.indexOf("customer") !== -1,
                article: aFields.indexOf("article") !== -1,
                brand: aFields.indexOf("brand") !== -1
            });
            var oCfg = sComb ? pricingService.getConfig(sType, sComb) : null;
            var bConfigured = !!(oCfg && oCfg.active && oCfg.tableNo);
            oModel.setProperty("/configured", bConfigured);
            oModel.setProperty("/tableText", bConfigured ? pricingService.tableName(oCfg.tableNo) : this._i18n("Pricing_Not_Configured_Short"));
            this._clearStates();
        },

        onCampaignChange: function (oEvent) {
            var sId = oEvent.getParameter("selectedItem").getKey();
            this.getOwnerComponent().getRouter().navTo("campaignPricing", { campaignId: sId, "?query": this._query() }, true);
        },

        // A new condition type starts with empty condition details.
        onTypeChange: function () {
            var oModel = this._model();
            oModel.setProperty("/draft", this._blankDetails(oModel.getProperty("/draft")));
            this._applyType();
        },

        onCombinationSelect: function (oEvent) {
            var oModel = this._model();
            var oItem = oModel.getProperty("/combinations")[oEvent.getParameter("selectedIndex")];
            oModel.setProperty("/draft/combination", oItem ? oItem.key : "");
            this._applyCombination();
        },

        onBrandSelected: function (oEvent) {
            var oItem = oEvent.getParameter("selectedItem");
            if (oItem) {
                this._model().setProperty("/draft/brand", oItem.getKey());
            }
            this._clearState("brand");
        },

        onFieldChange: function (oEvent) {
            // Control IDs are "pricing" + field name, e.g. pricingSalesOrg -> salesOrg.
            var sLocal = (this.getView().getLocalId(oEvent.getSource().getId()) || "").replace(/^pricing/, "");
            var sField = sLocal.charAt(0).toLowerCase() + sLocal.slice(1);
            if (FIELDS.indexOf(sField) !== -1) {
                this._clearState(sField);
            }
            if (sField === "validFrom" || sField === "validTo") {
                this._clearState(sField === "validFrom" ? "validTo" : "validFrom");
            }
        },

        _clearState: function (sField) {
            this._model().setProperty("/state/" + sField, "None");
            this._model().setProperty("/stateText/" + sField, "");
        },

        _clearStates: function () {
            FIELDS.forEach(this._clearState, this);
        },

        _showMessages: function (aMsg) {
            var oModel = this._model();
            this._clearStates();
            aMsg.forEach(function (m) {
                if (m.field && oModel.getProperty("/state/" + m.field)) {
                    oModel.setProperty("/state/" + m.field, "Error");
                    oModel.setProperty("/stateText/" + m.field, m.text);
                }
            });
            MessageBox.error(aMsg.map(function (m) { return m.text; }).join("\n"));
        },

        // Adds the draft row to the records table; sales area, dates and condition type stay for the next row.
        onAddDraft: function () {
            var that = this;
            var oModel = this._model();
            pricingService.addDraft(oModel.getProperty("/draft")).then(function () {
                that._filterRecords(oModel.getProperty("/campaignId"));
                ["customer", "article", "brand", "rate"].forEach(function (k) {
                    oModel.setProperty("/draft/" + k, "");
                });
                that._clearStates();
                MessageToast.show(that._i18n("Pricing_Draft_Added"));
            }).catch(function (oError) {
                that._showMessages(oError.messages || [{ text: oError.message }]);
            });
        },

        onClearDraft: function () {
            var oModel = this._model();
            oModel.setProperty("/draft", this._blankDetails(oModel.getProperty("/draft")));
            this._clearStates();
        },

        // ------------------------------------------------------------ records

        _rowFromEvent: function (oEvent) {
            return oEvent.getSource().getBindingContext("PricingModel").getObject();
        },

        onRemoveRow: function (oEvent) {
            var oRow = this._rowFromEvent(oEvent);
            MessageBox.confirm(this._i18n("Pricing_Remove_Confirm"), {
                onClose: function (sAction) {
                    if (sAction === MessageBox.Action.OK) {
                        pricingService.removeDraft(oRow.rowId);
                    }
                }
            });
        },

        // Change/delimit a saved record: only its Valid To can be shortened (§4.3).
        onDelimit: function (oEvent) {
            var that = this;
            var oRow = this._rowFromEvent(oEvent);
            var oPicker = new DatePicker({ dateValue: oRow.validTo, displayFormat: "dd-MM-yyyy", minDate: oRow.validFrom, maxDate: oRow.validTo });
            var oDialog = new Dialog({
                title: this._i18n("Pricing_Delimit_Title", [oRow.recordNo]),
                content: new VBox({ items: [new Label({ text: this._i18n("Pricing_Valid_To"), labelFor: oPicker }), oPicker] }).addStyleClass("sapUiSmallMargin"),
                beginButton: new Button({
                    text: this._i18n("Pricing_Delimit"),
                    type: "Emphasized",
                    press: function () {
                        oDialog.setBusy(true);
                        pricingService.delimit(oRow.rowId, oPicker.getDateValue()).then(function () {
                            oDialog.close();
                            MessageToast.show(that._i18n("Pricing_Delimited", [oRow.recordNo]));
                        }).catch(function (oError) {
                            MessageBox.error(oError.message);
                        }).finally(function () {
                            oDialog.setBusy(false);
                        });
                    }
                }),
                endButton: new Button({
                    text: this._i18n("Cancel"),
                    press: function () { oDialog.close(); }
                }),
                afterClose: function () { oDialog.destroy(); }
            });
            this.getView().addDependent(oDialog);
            oDialog.open();
        },

        // Per-row results: saved rows show the S/4 record number, failed rows their message (§13).
        onSave: function () {
            var that = this;
            var oModel = this._model();
            oModel.setProperty("/busy", true);
            pricingService.save(oModel.getProperty("/campaignId")).then(function (o) {
                if (!o.saved && !o.failed && !o.errors) {
                    MessageBox.information(that._i18n("Pricing_Nothing_Open"));
                } else if (o.failed || o.errors) {
                    MessageBox.warning(that._i18n("Pricing_Save_Partial", [o.saved, o.failed, o.errors]));
                } else {
                    MessageBox.success(that._i18n("Pricing_Save_Ok", [o.saved]));
                }
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        // Rows incl. status and error message (row-level error download, §4.2).
        onExport: function () {
            var that = this;
            var aRows = this.byId("pricingTableRecords").getBinding("items").getContexts(0, Infinity).map(function (c) {
                var o = c.getObject();
                return Object.assign({}, o, {
                    validFromText: that.formatDate(o.validFrom),
                    validToText: that.formatDate(o.validTo),
                    statusText: that.formatStatus(o.status)
                });
            });
            sap.ui.require(["sap/ui/export/Spreadsheet"], function (Spreadsheet) {
                var oSheet = new Spreadsheet({
                    workbook: {
                        columns: [
                            { label: that._i18n("Camp_Id"), property: "campaignId" },
                            { label: that._i18n("Pricing_Col_Type"), property: "conditionType" },
                            { label: that._i18n("Pricing_Col_Combination"), property: "combination" },
                            { label: that._i18n("Pricing_Sales_Org"), property: "salesOrg" },
                            { label: that._i18n("Pricing_Dist_Channel"), property: "distChannel" },
                            { label: that._i18n("Pricing_Customer"), property: "customer" },
                            { label: that._i18n("Pricing_Article"), property: "article" },
                            { label: that._i18n("Pricing_Hierarchy"), property: "hierarchy" },
                            { label: that._i18n("Pricing_Brand"), property: "brand" },
                            { label: that._i18n("Pricing_Col_Value"), property: "rate" },
                            { label: that._i18n("Pricing_Currency"), property: "rateUnit" },
                            { label: that._i18n("Pricing_Pricing_Unit"), property: "pricingUnit" },
                            { label: that._i18n("Pricing_Uom"), property: "uom" },
                            { label: that._i18n("Pricing_Valid_From"), property: "validFromText" },
                            { label: that._i18n("Pricing_Valid_To"), property: "validToText" },
                            { label: that._i18n("Camp_Status"), property: "statusText" },
                            { label: that._i18n("Pricing_Col_Message"), property: "message" },
                            { label: that._i18n("Pricing_Col_Record"), property: "recordNo" }
                        ]
                    },
                    dataSource: aRows,
                    fileName: "Pricing_" + that._model().getProperty("/campaignId") + ".xlsx"
                });
                oSheet.build().finally(function () {
                    oSheet.destroy();
                });
            });
        },

        // ------------------------------------------------------------ navigation

        _query: function () {
            return this._sFrom ? { from: this._sFrom } : {};
        },

        // The configuration returns here (same campaign and origin) on back.
        onOpenConfig: function () {
            backNavGuard.disarm();
            this.getOwnerComponent().getRouter().navTo("pricingConfig", {
                "?query": Object.assign({ campaignId: this._model().getProperty("/campaignId") }, this._query())
            });
        },

        onNavBack: function () {
            this.handleBackButton();
        },

        // Same "leave this page?" popup as the other screens (header back and browser back). Back goes
        // to the campaign detail when opened from there, else to the list; drafts stay in the session.
        handleBackButton: function (event) {
            if (event && typeof event.preventDefault === "function") {
                event.preventDefault();
            }
            if (!confirm(this._i18n("sure_leave_page"))) {
                backNavGuard.rearm();
                return;
            }
            backNavGuard.disarm();
            var oRouter = this.getOwnerComponent().getRouter();
            if (this._sFrom === "detail") {
                oRouter.navTo("campaignDetail", {
                    campaignId: this._model().getProperty("/campaignId"),
                    "?query": { mode: "display" }
                }, true);
                return;
            }
            oRouter.navTo("campaignList", {}, true);
        }
    });
});
