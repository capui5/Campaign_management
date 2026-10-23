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

    // Pricing Key Configuration (FDD Addendum v1.1 §18 - §20): the 20 approved condition-type /
    // key-combination mappings with their Axxx condition table number, default and active flags and
    // the S/4 validation status; the field mapping of the selected row below. IT/SD administrator
    // function: S/4 checks the authorization and validates every mapping on save (§21.1).
    // Route: pricingConfig, ?campaignId=...&from=... when opened from the pricing screen (back returns
    // there, else to the list). Edits apply to the pricing screen at once (active combinations, table
    // number); they reach S/4 only through Save.
    return Controller.extend("com.luxasia.campaignmanagement.controller.pricingConfig", {
        formatType: function (sType) {
            return sType ? this._i18n("Pricing_Type_" + sType) : "";
        },

        // Sales Org / Distribution Channel / Campaign ID / <combination key fields> (§19).
        formatBusinessKey: function (sComb) {
            var that = this;
            if (!sComb) {
                return "";
            }
            var aKeys = [this._i18n("Pricing_Sales_Org"), this._i18n("Pricing_Dist_Channel"), this._i18n("Camp_Id")];
            pricingService.COMBINATIONS[sComb].fields.forEach(function (f) {
                if (f === "brand") {
                    aKeys.push(that._i18n("Pricing_Hierarchy"));
                }
                aKeys.push(that._i18n(f === "brand" ? "Pricing_Brand" : f === "customer" ? "Pricing_Customer" : "Pricing_Article"));
            });
            return aKeys.join(" / ");
        },

        formatValidation: function (sStatus) {
            return this._i18n("Config_Validation_" + (sStatus || pricingService.VALIDATION.NOT_VALIDATED));
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
            oModel.setProperty("/types", [{ key: "", text: this._i18n("Config_All_Types") }].concat(
                Object.keys(pricingService.CONDITION_TYPES).map(function (k) {
                    return { key: k, text: k + " — " + that._i18n("Pricing_Type_" + k) };
                })));
            this._showFields(null);
            pricingService.init(this.getOwnerComponent()).then(function () {
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

        onTypeFilter: function () {
            var sType = this._model().getProperty("/type");
            var oBinding = this.byId("configTable").getBinding("items");
            if (oBinding) {
                oBinding.filter(sType ? [new Filter("conditionType", "EQ", sType)] : []);
            }
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

        // Logical field mapping (§18.2 FIELD_ID, UI_LABEL, REQUIRED, DEFAULT_RULE, VALUE_HELP); the
        // DDIC field of the Axxx table is resolved and validated by S/4.
        _showFields: function (oConfig) {
            var oModel = this._model();
            if (!oConfig) {
                oModel.setProperty("/fieldsTitle", this._i18n("Config_Fields_Title"));
                oModel.setProperty("/fieldRows", []);
                return;
            }
            var aRows = [
                { id: "SALES_ORG", label: this._i18n("Pricing_Sales_Org"), required: true, defaultRule: "NONE", valueHelp: "SALES_ORG" },
                { id: "DIST_CHANNEL", label: this._i18n("Pricing_Dist_Channel"), required: true, defaultRule: "CHANNEL_10", valueHelp: "" },
                { id: "CAMPAIGN", label: this._i18n("Camp_Id"), required: true, defaultRule: "CAMPAIGN", valueHelp: "CAMPAIGN" }
            ];
            var that = this;
            pricingService.COMBINATIONS[oConfig.combination].fields.forEach(function (f) {
                if (f === "brand") {
                    aRows.push({ id: "HIERARCHY", label: that._i18n("Pricing_Hierarchy"), required: true, defaultRule: "HIERARCHY_L2", valueHelp: "" });
                    aRows.push({ id: "BRAND", label: that._i18n("Pricing_Brand"), required: true, defaultRule: "NONE", valueHelp: "BRAND" });
                } else if (f === "customer") {
                    aRows.push({ id: "CUSTOMER", label: that._i18n("Pricing_Customer"), required: true, defaultRule: "NONE", valueHelp: "CUSTOMER" });
                } else {
                    aRows.push({ id: "ARTICLE", label: that._i18n("Pricing_Article"), required: true, defaultRule: "NONE", valueHelp: "ARTICLE" });
                }
            });
            oModel.setProperty("/fieldsTitle", this._i18n("Config_Fields_Title_For", [oConfig.conditionType, oConfig.combination, oConfig.fieldSet]));
            oModel.setProperty("/fieldRows", aRows);
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
                    FieldSet: c.fieldSet,
                    Active: c.active,
                    Default: c.isDefault,
                    ValidationStatus: c.validation
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
