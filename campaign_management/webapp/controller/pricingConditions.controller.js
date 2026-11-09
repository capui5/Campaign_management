sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/Sorter",
    "sap/m/SelectDialog",
    "sap/m/StandardListItem",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "com/luxasia/campaignmanagement/util/campaignService",
    "com/luxasia/campaignmanagement/util/pricingService",
    "com/luxasia/campaignmanagement/util/pricingFormatter",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, Filter, Sorter, SelectDialog, StandardListItem, MessageBox, MessageToast,
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

    // Multi-select key fields: field -> PricingModel list (CAP master data) and dialog title.
    var PICK = {
        salesOrg: { list: "salesOrgs", title: "Pricing_Help_Sales_Org" },
        brand: { list: "brands", title: "Pricing_Help_Brand" },
        customer: { list: "customers", title: "Pricing_Help_Customer" },
        article: { list: "articles", title: "Pricing_Help_Article" },
        rateUnit: { list: "currencies", title: "Pricing_Help_Currency" },
        uom: { list: "uoms", title: "Pricing_Help_Uom" }
    };
    var MAX_DRAFTS = 500; // rows one "Add" may create (product of the picked values)

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
                editRowId: "",
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
                // Current table numbers / active flags from CAP (API 2.1 / 3.2 / 3.1), also when they
                // were maintained after the app was opened.
                return pricingService.reloadCatalog().catch(function (oError) {
                    MessageBox.warning(oError.message);
                });
            }).then(function () {
                that.getView().setModel(pricingService.getModel(), "PricingModel");
                that._filterRecords(sId);
                // Sales org / brand / customer / article value help lists (CAP).
                pricingService.loadValueHelps();
                return Promise.all([that._campaign(sId), pricingService.loadConditions(sId), pricingService.loadConditionTypes(),
                    // Campaign picker: always the full list from CAP, also when the page is opened directly.
                    campaignService.listAll().catch(function () { return []; })]);
            }).then(function (aResults) {
                var oCampaign = aResults[0];
                oModel.setProperty("/country", oCampaign.country);
                oModel.setProperty("/campaigns", that._campaignList(oCampaign, aResults[3]));
                // Condition types from CAP ConditionTypes (code + DESCRIPTION) only.
                var aTypes = aResults[2];
                oModel.setProperty("/types", aTypes);
                var bKnown = aTypes.some(function (t) { return t.key === sType; });
                if (!aTypes.length) {
                    // CAP answered but has no active condition types configured.
                    MessageBox.warning(that._i18n("Pricing_No_Types"));
                } else if (pricingService.getModel().getProperty("/keysError")) {
                    MessageBox.warning(pricingService.getModel().getProperty("/keysError"));
                }
                that._resetDraft(bKnown ? sType : (aTypes[0] || {}).key || "");
                // Sections 1 - 3 show the campaign's latest stored record (API 5.1); section 4 lists all.
                var oLatest = that._latestRecord(aResults[1]);
                if (oLatest) {
                    that._fillFromRecord(oLatest);
                }
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

        // Campaign picker: all campaigns (Campaigns, newest first), plus this one if it is not among them.
        _campaignList: function (oCurrent, aCampaigns) {
            var aList = (aCampaigns || []).map(function (c) {
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
        // Percentages keep % as their unit, which is not editable. The distribution channel is not
        // entered: it is set from the combination in _applyCombination, like the hierarchy.
        _blankDetails: function (oDraft) {
            var bPercent = (pricingService.typeInfo(oDraft.conditionType) || {}).kind === "percent";
            return Object.assign({}, oDraft, {
                salesOrg: "",
                customer: "",
                article: "",
                brand: "",
                salesOrgTokens: [],
                customerTokens: [],
                articleTokens: [],
                brandTokens: [],
                rateUnitTokens: [],
                uomTokens: [],
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
            var oModel = this._model();
            var sType = oModel.getProperty("/draft/conditionType");
            var sKind = (pricingService.typeInfo(sType) || {}).kind;
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
                return { key: k, text: pricingService.combinationText(k) };
            }));
            oModel.setProperty("/combinationIndex", aCombs.indexOf(sComb));
            this._applyCombination();
        },

        _applyCombination: function () {
            var oModel = this._model();
            var sType = oModel.getProperty("/draft/conditionType");
            var sComb = oModel.getProperty("/draft/combination");
            var aFields = sComb ? pricingService.fieldsOf(sComb) : [];
            // Always the backend defaults of the DIST_CHANNEL ("10") and HIERARCHY ("L2") business keys.
            oModel.setProperty("/draft/distChannel", pricingService.distChannelFor(sComb));
            oModel.setProperty("/draft/hierarchy", pricingService.hierarchyFor(sComb));
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

        // Most recently changed (else created) record of the campaign; the last read when equal.
        _latestRecord: function (aRows) {
            var fnTime = function (o) {
                var d = o.changedOn || o.createdOn;
                return d ? d.getTime() : 0;
            };
            return (aRows || []).reduce(function (oBest, o) {
                return !oBest || fnTime(o) >= fnTime(oBest) ? o : oBest;
            }, null);
        },

        // Tokens of a multi-select field for one value, with the value help text when it is loaded.
        _tokensFor: function (sField, sKey) {
            if (!sKey) {
                return [];
            }
            var oItem = (pricingService.getModel().getProperty("/" + PICK[sField].list) || []).find(function (o) {
                return o.key === sKey;
            });
            return [{ key: sKey, text: (oItem && oItem.text) || sKey }];
        },

        // Sections 1 - 3 from a stored record: condition type, combination and all condition details.
        // Distribution channel and hierarchy still come from the combination's business keys.
        _fillFromRecord: function (oRow) {
            var that = this;
            var oModel = this._model();
            var bTypeKnown = (oModel.getProperty("/types") || []).some(function (t) { return t.key === oRow.conditionType; });
            if (!bTypeKnown) {
                return false;
            }
            var bPercent = (pricingService.typeInfo(oRow.conditionType) || {}).kind === "percent";
            var oDraft = this._blankDetails(Object.assign({}, oModel.getProperty("/draft"), {
                conditionType: oRow.conditionType,
                combination: oRow.combination
            }));
            ["salesOrg", "customer", "article", "brand", "uom"].forEach(function (k) {
                oDraft[k] = oRow[k] || "";
                oDraft[k + "Tokens"] = that._tokensFor(k, oRow[k]);
            });
            oDraft.rateUnit = bPercent ? pricingService.PERCENT : (oRow.rateUnit || "");
            oDraft.rateUnitTokens = bPercent ? [] : this._tokensFor("rateUnit", oRow.rateUnit);
            oDraft.rate = oRow.rate || "";
            oDraft.pricingUnit = oRow.pricingUnit || "";
            oDraft.validFrom = oRow.validFrom ? new Date(oRow.validFrom.getTime()) : null;
            oDraft.validTo = oRow.validTo ? new Date(oRow.validTo.getTime()) : null;
            oModel.setProperty("/draft", oDraft);
            this._applyType();
            return true;
        },

        // A record of the table is shown in sections 1 - 3.
        onRecordPress: function (oEvent) {
            var oRow = oEvent.getSource().getBindingContext("PricingModel").getObject();
            if (this._fillFromRecord(oRow)) {
                // Not yet posted records are changed in place (PATCH) by the next Add Draft; a posted
                // record only serves as a template for a new one.
                var bEdit = oRow.status !== pricingService.STATUS.POSTED;
                this._model().setProperty("/editRowId", bEdit ? oRow.rowId : "");
                MessageToast.show(this._i18n(bEdit ? "Pricing_Record_Edit" : "Pricing_Record_Loaded",
                    [oRow.conditionType, oRow.combination]));
                this.byId("pricingConditionsPage").scrollTo(0, 200);
            }
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

        // Field name from the control ID: pricingSalesOrg -> salesOrg.
        _fieldOf: function (oControl) {
            var sLocal = (this.getView().getLocalId(oControl.getId()) || "").replace(/^pricing/, "");
            return sLocal.charAt(0).toLowerCase() + sLocal.slice(1);
        },

        // ------------------------------------------------------------ multi-select value helps

        // Opens the multi-select value help of a key field, with the current tokens ticked.
        onValueHelp: function (oEvent) {
            var sField = this._fieldOf(oEvent.getSource());
            var mPicked = {};
            (this._model().getProperty("/draft/" + sField + "Tokens") || []).forEach(function (t) {
                mPicked[t.key] = true;
            });
            var aItems = (pricingService.getModel().getProperty("/" + PICK[sField].list) || []).map(function (o) {
                return { key: o.key, text: o.text === o.key ? "" : o.text, info: o.info || "", selected: !!mPicked[o.key] };
            });
            var oDialog = this._pickDialog(sField);
            oDialog.getModel("vh").setData({ items: aItems });
            oDialog.getBinding("items").filter([]);
            oDialog.open("");
        },

        _pickDialog: function (sField) {
            this._mPick = this._mPick || {};
            if (this._mPick[sField]) {
                return this._mPick[sField];
            }
            var that = this;
            var oVh = new JSONModel({ items: [] });
            oVh.setSizeLimit(5000);
            function search(oEvt) {
                var sLower = (oEvt.getParameter("value") || "").toLowerCase();
                oEvt.getSource().getBinding("items").filter(sLower ? [new Filter({
                    path: "",
                    test: function (o) {
                        return (o.key + " " + o.text).toLowerCase().indexOf(sLower) !== -1;
                    }
                })] : []);
            }
            var oDialog = new SelectDialog({
                title: this._i18n(PICK[sField].title),
                noDataText: this._i18n("Pricing_Help_Empty"),
                multiSelect: true,
                rememberSelections: true,
                growingThreshold: 200,
                items: {
                    path: "vh>/items",
                    sorter: new Sorter("key"),
                    templateShareable: false,
                    template: new StandardListItem({
                        title: "{vh>key}",
                        description: "{vh>text}",
                        info: "{vh>info}",
                        selected: "{vh>selected}"
                    })
                },
                search: search,
                liveChange: search,
                confirm: function () {
                    // Read the ticks from the model, so values hidden by the search stay picked.
                    that._setTokens(sField, oVh.getProperty("/items").filter(function (o) { return o.selected; }));
                }
            });
            oDialog.setModel(oVh, "vh");
            this.getView().addDependent(oDialog);
            this._mPick[sField] = oDialog;
            return oDialog;
        },

        // Tokens of a key field; the single draft value is the first one (used for the summary only,
        // "Add" creates a row per picked value).
        _setTokens: function (sField, aPicked) {
            var oModel = this._model();
            var aTokens = aPicked.map(function (o) { return { key: o.key, text: o.text || o.key }; });
            oModel.setProperty("/draft/" + sField + "Tokens", aTokens);
            oModel.setProperty("/draft/" + sField, aTokens.length ? aTokens[0].key : "");
            this._clearState(sField);
        },

        // Token removed with its x / backspace.
        onTokenUpdate: function (oEvent) {
            if (oEvent.getParameter("type") !== "removed") {
                return;
            }
            var sField = this._fieldOf(oEvent.getSource());
            var mGone = {};
            oEvent.getParameter("removedTokens").forEach(function (t) {
                mGone[t.getKey()] = true;
            });
            this._setTokens(sField, (this._model().getProperty("/draft/" + sField + "Tokens") || []).filter(function (t) {
                return !mGone[t.key];
            }));
        },

        // Whether a multi-select field is shown (and so part of the combinations): customer / article /
        // brand follow the key combination, currency is a fixed "%" for discounts, unit of measure is
        // only for prices.
        _pickShown: function (sField) {
            var oModel = this._model();
            var sKind = oModel.getProperty("/kind");
            if (sField === "rateUnit") {
                return sKind !== "percent";
            }
            if (sField === "uom") {
                return sKind === "price";
            }
            return sField === "salesOrg" || !!(oModel.getProperty("/fields") || {})[sField];
        },

        // One draft per combination of the picked values of the visible key fields. An empty field
        // gives one row with "" so validation reports it as mandatory.
        _expandDraft: function (oDraft) {
            var that = this;
            var aRows = [Object.assign({}, oDraft)];
            Object.keys(PICK).forEach(function (sField) {
                if (!that._pickShown(sField)) {
                    return;
                }
                var aKeys = (oDraft[sField + "Tokens"] || []).map(function (t) { return t.key; });
                if (!aKeys.length) {
                    aKeys = [""];
                }
                aRows = aRows.reduce(function (aOut, oRow) {
                    return aOut.concat(aKeys.map(function (sKey) {
                        var oNew = Object.assign({}, oRow);
                        oNew[sField] = sKey;
                        return oNew;
                    }));
                }, []);
            });
            return aRows.map(function (oRow) {
                Object.keys(PICK).forEach(function (sField) {
                    delete oRow[sField + "Tokens"];
                });
                return oRow;
            });
        },

        onFieldChange: function (oEvent) {
            var sField = this._fieldOf(oEvent.getSource());
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

        // Stores the draft as a DRAFT record (CampaignPricingRecords POST) and shows it in the records
        // table; sales area, dates and condition type stay for the next row.
        onAddDraft: function () {
            var that = this;
            var oModel = this._model();
            oModel.setProperty("/busy", true);
            var aDrafts = this._expandDraft(oModel.getProperty("/draft"));
            var sEditId = oModel.getProperty("/editRowId");
            if (sEditId) {
                this._updateDraft(sEditId, aDrafts);
                return;
            }
            if (aDrafts.length > MAX_DRAFTS) {
                oModel.setProperty("/busy", false);
                MessageBox.error(this._i18n("Pricing_Too_Many_Drafts", [aDrafts.length, MAX_DRAFTS]));
                return;
            }
            pricingService.addDrafts(aDrafts).then(function (aAdded) {
                that._filterRecords(oModel.getProperty("/campaignId"));
                ["customer", "article", "brand"].forEach(function (k) {
                    that._setTokens(k, []);
                });
                oModel.setProperty("/draft/rate", "");
                that._clearStates();
                MessageToast.show(aAdded.length > 1 ? that._i18n("Pricing_Drafts_Added", [aAdded.length]) :
                    that._i18n("Pricing_Draft_Added"));
            }).catch(function (oError) {
                that._showMessages(oError.messages || [{ text: oError.message }]);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        // The record loaded from the table is changed with PATCH; one value per key field.
        _updateDraft: function (sRowId, aDrafts) {
            var that = this;
            var oModel = this._model();
            if (aDrafts.length !== 1) {
                oModel.setProperty("/busy", false);
                MessageBox.error(this._i18n("Pricing_Edit_One_Value"));
                return;
            }
            pricingService.updateDraft(sRowId, aDrafts[0]).then(function (oRow) {
                that._filterRecords(oModel.getProperty("/campaignId"));
                oModel.setProperty("/editRowId", "");
                oModel.setProperty("/draft", that._blankDetails(oModel.getProperty("/draft")));
                that._clearStates();
                MessageToast.show(that._i18n("Pricing_Draft_Updated", [oRow.conditionType, oRow.combination]));
            }).catch(function (oError) {
                that._showMessages(oError.messages || [{ text: oError.message }]);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        onClearDraft: function () {
            var oModel = this._model();
            oModel.setProperty("/editRowId", "");
            oModel.setProperty("/draft", this._blankDetails(oModel.getProperty("/draft")));
            this._clearStates();
        },

        // ------------------------------------------------------------ records

        _rowFromEvent: function (oEvent) {
            return oEvent.getSource().getBindingContext("PricingModel").getObject();
        },

        // Only draft records (API 5.5) are deleted from the campaign pricing store (CampaignPricingRecords DELETE).
        onRemoveRow: function (oEvent) {
            var that = this;
            var oModel = this._model();
            var oRow = this._rowFromEvent(oEvent);
            MessageBox.confirm(this._i18n("Pricing_Remove_Confirm"), {
                onClose: function (sAction) {
                    if (sAction !== MessageBox.Action.OK) {
                        return;
                    }
                    oModel.setProperty("/busy", true);
                    pricingService.removeDraft(oRow.rowId).then(function () {
                        if (oModel.getProperty("/editRowId") === oRow.rowId) {
                            oModel.setProperty("/editRowId", "");
                        }
                        that._filterRecords(oModel.getProperty("/campaignId"));
                        MessageToast.show(that._i18n("Pricing_Removed"));
                    }).catch(function (oError) {
                        MessageBox.error(oError.message);
                    }).finally(function () {
                        oModel.setProperty("/busy", false);
                    });
                }
            });
        },

        // Per-row results: saved rows show the S/4 record number, failed rows their message (§13).
        onSave: function () {
            var that = this;
            var oModel = this._model();
            oModel.setProperty("/busy", true);
            pricingService.save(oModel.getProperty("/campaignId")).then(function (o) {
                if (!o.saved && !o.failed && !o.errors) {
                    MessageBox.information(that._i18n("Pricing_Nothing_Open"));
                } else if (!o.saved) {
                    // Nothing posted: error with the S/4 / validation messages shown directly.
                    MessageBox.error(that._i18n("Pricing_Save_Failed", [o.failed, o.errors]) + "\n\n" +
                        (o.messages || []).join("\n"));
                } else if (o.failed || o.errors) {
                    // Some posted, some not: warning.
                    MessageBox.warning(that._i18n("Pricing_Save_Partial", [o.saved, o.failed, o.errors]), {
                        details: (o.posted || []).length ? that._i18n("Pricing_Record_Numbers") + "\n" +
                            o.posted.join("\n") + "\n\n" + (o.messages || []).join("\n") : (o.messages || []).join("\n")
                    });
                } else {
                    // The S/4 record numbers (KNUMH) are also in the Record No. column of the table.
                    MessageBox.success(that._i18n("Pricing_Save_Ok", [o.saved]) + "\n\n" +
                        that._i18n("Pricing_Record_Numbers") + "\n" + (o.posted || []).join("\n"));
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
