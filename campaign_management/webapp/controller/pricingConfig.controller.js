sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/core/util/File",
    "sap/m/MessageBox",
    "com/luxasia/campaignmanagement/util/pricingService",
    "com/luxasia/campaignmanagement/util/backNavGuard"
], function (Controller, JSONModel, Filter, File, MessageBox, pricingService, backNavGuard) {
    "use strict";

    // Pricing Key Configuration (FDD Addendum v1.1 §18 - §20): the condition-type / key-combination
    // mappings of ConditionTypeKeyCombinations with their Axxx condition table number, default and
    // active flags and save state; the business keys (BUSINESS_KEYS) of the selected row below.
    // IT/SD administrator function: Save PATCHes each changed mapping (API §3.3).
    // Route: pricingConfig, ?campaignId=...&from=... when opened from the pricing screen (back returns
    // there, else to the list). Edits apply to the pricing screen at once (active combinations, table
    // number); they reach S/4 only through Save.
    return Controller.extend("com.luxasia.campaignmanagement.controller.pricingConfig", {
        // Description from CAP ConditionTypes.
        formatType: function (sType) {
            return sType ? pricingService.conditionTypeText(sType) : "";
        },

        // Business keys of the combination in SEQUENCE order, e.g. Sales Organization / Distribution
        // Channel / Campaign ID / Customer / Article / SKU (BUSINESS_KEYS, API §3.1).
        formatBusinessKey: function (sComb) {
            var oComb = sComb ? pricingService.combinationInfo(sComb) : null;
            return oComb ? oComb.keys.map(function (k) { return k.label; }).join(" / ") : "";
        },

        formatValidation: function (sStatus) {
            return this._i18n("Config_Validation_" + (sStatus || pricingService.VALIDATION.LOCAL));
        },

        formatTableNoState: function (sTableNo) {
            return !sTableNo || /^\d{3}$/.test(sTableNo) ? "None" : "Error";
        },

        onInit: function () {
            this.getView().setModel(new JSONModel({ busy: false, type: "", types: [], shown: 0, fieldsTitle: "", fieldRows: [] }), "config");
            this.getOwnerComponent().getRouter().getRoute("pricingConfig").attachPatternMatched(this._onRouteMatched, this);
        },

        _i18n: function (sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _model: function () {
            return this.getView().getModel("config");
        },

        _onRouteMatched: function (oEvent) {
            var that = this;
            this._oQuery = (oEvent.getParameter("arguments") || {})["?query"] || {};
            var oModel = this._model();
            oModel.setProperty("/busy", true);
            this._showFields(null);
            pricingService.init(this.getOwnerComponent()).then(function () {
                // API 2.1 / 3.2 / 3.1 read again: the table shows the current CAP configuration.
                return pricingService.reloadCatalog().catch(function (oError) {
                    MessageBox.warning(oError.message);
                });
            }).then(function () {
                oModel.setProperty("/types", [{ key: "", text: that._i18n("Config_All_Types") }].concat(
                    pricingService.conditionTypes().map(function (k) {
                        return { key: k, text: k + " — " + that.formatType(k) };
                    })));
                that.getView().setModel(pricingService.getModel(), "PricingModel");
                that.onTypeFilter();
            }).catch(function (oError) {
                MessageBox.error(oError.message);
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
            backNavGuard.arm(this);
        },

        onConfigsUpdated: function (oEvent) {
            this._model().setProperty("/shown", oEvent.getSource().getBinding("items").getLength());
        },

        // All types: the full matrix (API §3.2, read on init). One type: its active mappings with
        // business keys are read again (API §3.1) before the table is filtered.
        onTypeFilter: function () {
            var that = this;
            var oModel = this._model();
            var sType = oModel.getProperty("/type");
            var fnApply = function () {
                var oBinding = that.byId("configTable").getBinding("items");
                if (oBinding) {
                    oBinding.filter(sType ? [new Filter("conditionType", "EQ", sType)] : []);
                }
                that._showFields(null);
            };
            if (!sType) {
                fnApply();
                return;
            }
            oModel.setProperty("/busy", true);
            pricingService.loadConfigsFor(sType).catch(function (oError) {
                MessageBox.error(oError.message);
            }).then(fnApply).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        _configFromEvent: function (oEvent) {
            return oEvent.getSource().getBindingContext("PricingModel").getObject();
        },

        // Digits only; the derived table name is A + number (TABNAME is never entered freely).
        onTableNoChange: function (oEvent) {
            var oConfig = this._configFromEvent(oEvent);
            var sDigits = (oEvent.getParameter("value") || "").replace(/\D/g, "").slice(0, 3);
            oEvent.getSource().setValue(sDigits);
            oConfig.tableNo = sDigits;
            pricingService.markConfigChanged(oConfig);
            pricingService.getModel().refresh(true);
        },

        // At most one default combination per condition type.
        onDefaultSelect: function (oEvent) {
            var oConfig = this._configFromEvent(oEvent);
            if (oEvent.getParameter("selected")) {
                pricingService.getModel().getProperty("/configs").forEach(function (c) {
                    if (c !== oConfig && c.conditionType === oConfig.conditionType && c.isDefault) {
                        c.isDefault = false;
                        pricingService.markConfigChanged(c);
                    }
                });
            }
            pricingService.markConfigChanged(oConfig);
            pricingService.getModel().refresh(true);
        },

        // Deactivated combinations are no longer offered for new condition records (CFG-006);
        // existing records and their mapping stay traceable.
        onActiveSelect: function (oEvent) {
            pricingService.markConfigChanged(this._configFromEvent(oEvent));
            pricingService.getModel().refresh(true);
        },

        onSelectionChange: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            this._showFields(oItem ? oItem.getBindingContext("PricingModel").getObject() : null);
        },

        // Business keys of the combination (KEY_COMBINATION.BUSINESS_KEYS: FIELD_CODE, BUSINESS_KEY,
        // S4_FIELD, SEQUENCE, REQUIRED, DEFAULT_VALUE).
        _showFields: function (oConfig) {
            var oModel = this._model();
            var oComb = oConfig ? pricingService.combinationInfo(oConfig.combination) : null;
            if (!oComb) {
                oModel.setProperty("/fieldsTitle", this._i18n("Config_Fields_Title"));
                oModel.setProperty("/fieldRows", []);
                return;
            }
            oModel.setProperty("/fieldsTitle", this._i18n("Config_Fields_Title_For", [oConfig.conditionType, oConfig.combination,
                oComb.description]));
            oModel.setProperty("/fieldRows", oComb.keys.map(function (k) {
                return {
                    sequence: k.sequence,
                    id: k.field,
                    label: k.label,
                    required: k.required,
                    defaultValue: k.defaultValue || "—",
                    s4Field: k.s4Field || "—"
                };
            }));
        },

        onSave: function () {
            var that = this;
            var oModel = this._model();
            var aWarnings = pricingService.validateConfigs().filter(function (m) { return m.type === "Warning"; });
            oModel.setProperty("/busy", true);
            pricingService.saveConfigs().then(function (o) {
                if (!o.saved && !o.failed) {
                    MessageBox.information(that._i18n("Config_No_Changes"));
                } else if (o.failed) {
                    MessageBox.error(that._i18n("Config_Save_Partial", [o.saved, o.failed]) + "\n" + o.messages.join("\n"));
                } else {
                    MessageBox.success(that._i18n("Config_Save_Ok", [o.saved]) +
                        (aWarnings.length ? "\n" + aWarnings.map(function (m) { return m.text; }).join("\n") : ""));
                }
            }).catch(function (oError) {
                MessageBox.error((oError.messages || [{ text: oError.message }]).map(function (m) { return m.text; }).join("\n"));
            }).finally(function () {
                oModel.setProperty("/busy", false);
            });
        },

        // Mapping download for controlled review and transport reconciliation (§20 Export).
        onExport: function () {
            var aConfigs = pricingService.getModel().getProperty("/configs").map(function (c) {
                return {
                    ConditionType: c.conditionType,
                    CombinationId: c.combination,
                    ConditionTableNumber: c.tableNo || "TBD",
                    TableName: pricingService.tableName(c.tableNo),
                    Description: c.fieldSet,
                    BusinessKeys: (pricingService.combinationInfo(c.combination) || { keys: [] }).keys.map(function (k) { return k.field; }),
                    Active: c.active,
                    Default: c.isDefault,
                    SaveStatus: c.validation
                };
            });
            File.save(JSON.stringify(aConfigs, null, 2), "campaign_condition_mapping", "json", "application/json");
        },

        onNavBack: function () {
            this.handleBackButton();
        },

        // Same "leave this page?" popup as the other screens (header back and browser back).
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
            var oQuery = this._oQuery || {};
            if (oQuery.campaignId) {
                oRouter.navTo("campaignPricing", {
                    campaignId: oQuery.campaignId,
                    "?query": oQuery.from ? { from: oQuery.from } : {}
                }, true);
                return;
            }
            oRouter.navTo("campaignList", {}, true);
        }
    });
});
