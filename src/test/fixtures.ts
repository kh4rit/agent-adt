const ADTCORE = 'xmlns:adtcore="http://www.sap.com/adt/core"'

export const CLASS_URL = "/sap/bc/adt/oo/classes/zcl_demo"
export const CLASS_SOURCE_URL = `${CLASS_URL}/source/main`
export const CLASS_TEST_URL = `${CLASS_URL}/includes/testclasses`
export const PROG_URL = "/sap/bc/adt/programs/programs/zdemo_report"
export const INCL_URL = "/sap/bc/adt/programs/includes/zdemo_incl"

export const searchClass = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences ${ADTCORE}>
  <adtcore:objectReference adtcore:uri="${CLASS_URL}" adtcore:type="CLAS/OC" adtcore:name="ZCL_DEMO" adtcore:packageName="ZDEMO" adtcore:description="Demo class"/>
</adtcore:objectReferences>`

export const searchAmbiguous = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences ${ADTCORE}>
  <adtcore:objectReference adtcore:uri="${CLASS_URL}" adtcore:type="CLAS/OC" adtcore:name="ZDEMO" adtcore:packageName="ZDEMO" adtcore:description="Demo class"/>
  <adtcore:objectReference adtcore:uri="${PROG_URL}" adtcore:type="PROG/P" adtcore:name="ZDEMO" adtcore:packageName="ZDEMO" adtcore:description="Demo report"/>
</adtcore:objectReferences>`

export const searchEmpty = `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences ${ADTCORE}/>`

const links = (href: string) =>
  `<atom:link href="${href}" rel="http://www.sap.com/adt/relations/source" type="text/plain" etag="20260901100000"/>
   <atom:link href="${href}" rel="http://www.sap.com/adt/relations/source" type="text/html"/>`

export const classStructure = `<?xml version="1.0" encoding="utf-8"?>
<class:abapClass xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:abapoo="http://www.sap.com/adt/oo" xmlns:abapsource="http://www.sap.com/adt/abapsource" ${ADTCORE} xmlns:atom="http://www.w3.org/2005/Atom"
  class:final="true" class:abstract="false" class:visibility="public" class:category="generalObjectType" class:sharedMemoryEnabled="false" abapoo:modeled="false"
  abapsource:sourceUri="source/main" abapsource:fixPointArithmetic="true" abapsource:activeUnicodeCheck="true"
  adtcore:responsible="DEVELOPER" adtcore:masterLanguage="EN" adtcore:masterSystem="NPL" adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC"
  adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="inactive" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:createdBy="DEVELOPER" adtcore:description="Demo class" adtcore:language="EN">
  ${links("source/main")}
  <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/zdemo" adtcore:type="DEVC/K" adtcore:name="ZDEMO"/>
  <class:include class:includeType="main" abapsource:sourceUri="source/main" adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC" adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="inactive" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:createdBy="DEVELOPER">
    ${links("source/main")}
  </class:include>
  <class:include class:includeType="testclasses" abapsource:sourceUri="includes/testclasses" adtcore:name="ZCL_DEMO" adtcore:type="CLAS/OC" adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="active" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:createdBy="DEVELOPER">
    ${links("includes/testclasses")}
  </class:include>
</class:abapClass>`

export const programStructure = `<?xml version="1.0" encoding="utf-8"?>
<program:abapProgram xmlns:program="http://www.sap.com/adt/programs/programs" xmlns:abapsource="http://www.sap.com/adt/abapsource" ${ADTCORE} xmlns:atom="http://www.w3.org/2005/Atom"
  program:lockedByEditor="false" program:programType="executableProgram" abapsource:sourceUri="source/main" abapsource:fixPointArithmetic="true" abapsource:activeUnicodeCheck="true"
  adtcore:responsible="DEVELOPER" adtcore:masterLanguage="EN" adtcore:masterSystem="NPL" adtcore:name="ZDEMO_REPORT" adtcore:type="PROG/P"
  adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="active" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:createdBy="DEVELOPER" adtcore:description="Demo report" adtcore:language="EN">
  ${links("source/main")}
</program:abapProgram>`

export const includeStructure = `<?xml version="1.0" encoding="utf-8"?>
<include:abapInclude xmlns:include="http://www.sap.com/adt/programs/includes" xmlns:abapsource="http://www.sap.com/adt/abapsource" ${ADTCORE} xmlns:atom="http://www.w3.org/2005/Atom"
  abapsource:sourceUri="source/main" adtcore:responsible="DEVELOPER" adtcore:name="ZDEMO_INCL" adtcore:type="PROG/I"
  adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="active" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:description="Demo include" adtcore:language="EN">
  ${links("source/main")}
</include:abapInclude>`

export const mainPrograms = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences ${ADTCORE}>
  <adtcore:objectReference adtcore:uri="${PROG_URL}" adtcore:type="PROG/P" adtcore:name="ZDEMO_REPORT"/>
</adtcore:objectReferences>`

export const classSource = `CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run RETURNING VALUE(rv_result) TYPE string.
ENDCLASS.

CLASS zcl_demo IMPLEMENTATION.
  METHOD run.
    rv_result = 'hello'.
  ENDMETHOD.
ENDCLASS.
`

export const lockResult = (corrnr = "", isLocal = "") => `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<LOCK_HANDLE>H4NDLE</LOCK_HANDLE><CORRNR>${corrnr}</CORRNR><CORRUSER>DEVELOPER</CORRUSER><CORRTEXT>Demo transport</CORRTEXT>
<IS_LOCAL>${isLocal}</IS_LOCAL><IS_LINK_UP/><MODIFICATION_SUPPORT>ABAP</MODIFICATION_SUPPORT>
</DATA></asx:values></asx:abap>`

const header = (trkorr: string, text: string, owner: string) =>
  `<TRKORR>${trkorr}</TRKORR><TRFUNCTION>K</TRFUNCTION><TRSTATUS>D</TRSTATUS><TARSYSTEM>NPL</TARSYSTEM><AS4USER>${owner}</AS4USER><AS4DATE>20260901</AS4DATE><AS4TIME>100000</AS4TIME><AS4TEXT>${text}</AS4TEXT><CLIENT>001</CLIENT>`

export const request = (trkorr: string, text: string, owner = "DEVELOPER") => `<CTS_REQUEST><REQ_HEADER>${header(trkorr, text, owner)}</REQ_HEADER><TASK_HEADERS/></CTS_REQUEST>`

/** LOCKS content: the object is recorded in request `trkorr` (owner) with one task. */
export const objectLock = (trkorr: string, text: string, owner: string, task: string, taskOwner: string) =>
  `<CTS_OBJECT_LOCK><OBJECT_KEY><OBJ_NAME>ZCL_DEMO</OBJ_NAME><OBJECT>CLAS</OBJECT><PGMID>R3TR</PGMID></OBJECT_KEY><LOCK_HOLDER><REQ_HEADER>${header(trkorr, text, owner)}</REQ_HEADER><TASK_HEADERS><CTS_TASK_HEADER>${header(task, text, taskOwner)}</CTS_TASK_HEADER></TASK_HEADERS></LOCK_HOLDER></CTS_OBJECT_LOCK>`

export const transportChecks = (dlvunit = "HOME", requests = [request("NPLK900010", "Demo transport"), request("NPLK900020", "Other transport")], locks = "") =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<PGMID>R3TR</PGMID><OBJECT>CLAS</OBJECT><OBJECTNAME>ZCL_DEMO</OBJECTNAME><OPERATION/><DEVCLASS>ZDEMO</DEVCLASS><CTEXT>Demo package</CTEXT><KORRFLAG>X</KORRFLAG><AS4USER>DEVELOPER</AS4USER><PDEVCLASS/><DLVUNIT>${dlvunit}</DLVUNIT><NAMESPACE/><RESULT>S</RESULT><RECORDING>X</RECORDING><EXISTING_REQ_ONLY/>
<REQUESTS>${requests.join("")}</REQUESTS>${locks ? `<LOCKS>${locks}</LOCKS>` : "<LOCKS/>"}
</DATA></asx:values></asx:abap>`

export const activationErrors = `<?xml version="1.0" encoding="utf-8"?>
<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist">
  <msg objDescr="Class ZCL_DEMO, Method RUN" type="E" line="8" href="${CLASS_SOURCE_URL}#start=8,4" forceSupported="false">
    <shortText><txt>Field "LV_UNKNOWN" is unknown. It is neither in one of the specified tables nor defined by a "DATA" statement.</txt></shortText>
  </msg>
  <msg objDescr="Class ZCL_DEMO, Local test class LTC_DEMO" type="W" href="${CLASS_TEST_URL}#start=3,0" forceSupported="true">
    <shortText><txt>The method "TEST_RUN" is not called anywhere.</txt></shortText>
  </msg>
</chkl:messages>`

export const activationInactiveList = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects">
  <ioc:entry>
    <ioc:object ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref ${ADTCORE} adtcore:uri="${CLASS_URL}" adtcore:type="CLAS/OC" adtcore:name="ZCL_DEMO" adtcore:parentUri="${CLASS_URL}" adtcore:description="Demo class"/>
    </ioc:object>
    <ioc:transport ioc:user="DEVELOPER" ioc:deleted="false">
      <ioc:ref ${ADTCORE} adtcore:uri="/sap/bc/adt/cts/transportrequests/NPLK900010/tasks/NPLK900011" adtcore:type="TASK" adtcore:name="NPLK900011" adtcore:parentUri="/sap/bc/adt/cts/transportrequests/NPLK900010" adtcore:description="Demo transport"/>
    </ioc:transport>
  </ioc:entry>
</ioc:inactiveObjects>`

export const syntaxErrors = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="${CLASS_SOURCE_URL}" chkrun:status="processed" chkrun:statusText="Check successful">
    <chkrun:checkMessageList>
      <chkrun:checkMessage chkrun:uri="${CLASS_SOURCE_URL}#start=8,4" chkrun:type="E" chkrun:shortText="Field &quot;LV_UNKNOWN&quot; is unknown."/>
    </chkrun:checkMessageList>
  </chkrun:checkReport>
</chkrun:checkRunReports>`

export const syntaxClean = `<?xml version="1.0" encoding="utf-8"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun" chkrun:triggeringUri="${CLASS_SOURCE_URL}" chkrun:status="processed" chkrun:statusText="Check successful">
    <chkrun:checkMessageList/>
  </chkrun:checkReport>
</chkrun:checkRunReports>`

export const nodePath = `<?xml version="1.0" encoding="utf-8"?>
<projectexplorer:nodepath xmlns:projectexplorer="http://www.sap.com/adt/projectexplorer" ${ADTCORE}>
  <projectexplorer:objectLinkReferences>
    <objectLinkReference adtcore:uri="/sap/bc/adt/packages/zdemo" adtcore:type="DEVC/K" adtcore:name="ZDEMO" projectexplorer:category="packages"/>
    <objectLinkReference adtcore:uri="${CLASS_URL}" adtcore:type="CLAS/OC" adtcore:name="ZCL_DEMO" projectexplorer:category="classes"/>
  </projectexplorer:objectLinkReferences>
</projectexplorer:nodepath>`

export const adtError = (message: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNoAccess"/>
  <message lang="EN">${message}</message><localizedMessage lang="EN">${message}</localizedMessage>
  <properties/>
</exc:exception>`

export const ddlsStructure = `<?xml version="1.0" encoding="utf-8"?>
<ddl:ddlSource xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources" xmlns:abapsource="http://www.sap.com/adt/abapsource" ${ADTCORE} xmlns:atom="http://www.w3.org/2005/Atom"
  abapsource:sourceUri="source/main" adtcore:responsible="DEVELOPER" adtcore:name="ZI_DEMO" adtcore:type="DDLS/DF"
  adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="active" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:description="Demo view" adtcore:language="EN">
  ${links("source/main")}
</ddl:ddlSource>`

export const structureStructure = `<?xml version="1.0" encoding="utf-8"?>
<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue" xmlns:abapsource="http://www.sap.com/adt/abapsource" ${ADTCORE} xmlns:atom="http://www.w3.org/2005/Atom"
  abapsource:sourceUri="source/main" adtcore:responsible="DEVELOPER" adtcore:name="ZS_DEMO" adtcore:type="TABL/DS"
  adtcore:changedAt="2026-09-01T10:00:00Z" adtcore:version="active" adtcore:createdAt="2026-08-01T00:00:00Z" adtcore:changedBy="DEVELOPER" adtcore:description="Demo structure" adtcore:language="EN">
  ${links("source/main")}
</blue:blueSource>`

export const validationOk = `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><CHECK_RESULT>X</CHECK_RESULT></DATA></asx:values></asx:abap>`

export const parentPackage = `<?xml version="1.0" encoding="utf-8"?>
<pak:package xmlns:pak="http://www.sap.com/adt/packages" ${ADTCORE} adtcore:name="ZPARENT" adtcore:type="DEVC/K" adtcore:description="Parent package">
  <pak:attributes pak:packageType="structure"/>
  <pak:superPackage/>
  <pak:transport>
    <pak:softwareComponent pak:name="HOME" pak:description="Customer developments"/>
    <pak:transportLayer pak:name="ZNPL" pak:description="Customer layer"/>
  </pak:transport>
</pak:package>`

export const programStructureWithVersions = programStructure.replace(
  "</program:abapProgram>",
  `  <atom:link href="source/main/versions" rel="http://www.sap.com/adt/relations/versions" title="Historic versions"/>
</program:abapProgram>`
)

const versionEntry = (n: string, stamp: string, date: string, request: string, title: string, author: string) => `<atom:entry>
  <atom:author><atom:name>${author}</atom:name></atom:author>
  <atom:content type="text/plain" src="${PROG_URL}/source/main/versions/${stamp}/${n}/content"/>
  <atom:id>${n}</atom:id>
  <atom:link adtcore:name="${request}" href="/sap/bc/adt/vit/wb/object_type/%20%20%20%20rq/object_name/${request}" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.sapgui" title="${title}"/>
  <atom:link adtcore:name="${request}" href="/sap/bc/adt/cts/transportrequests/${request}" rel="http://www.sap.com/adt/relations/transport/request" type="application/vnd.sap.adt.transportrequests.v1+xml" title="${title}"/>
  <atom:title>${title}</atom:title>
  <atom:updated>${date}</atom:updated>
</atom:entry>`

/** Version list as SAP returns it (newest first). */
export const versionFeed = `<?xml version="1.0" encoding="utf-8"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" ${ADTCORE}>
<atom:title>Version List of ZDEMO_REPORT (REPS)</atom:title><atom:updated>2026-10-26T14:31:35Z</atom:updated>
${versionEntry("00001", "20261026143135", "2026-10-26T14:31:35Z", "NPLK900071", "Second change", "OTHER")}
${versionEntry("00000", "20261026143135", "2026-10-22T06:29:43Z", "NPLK900070", "First version", "DEVELOPER")}
</atom:feed>`

const tmLinks = (nr: string) =>
  `<atom:link href="/sap/bc/adt/cts/transportrequests/${nr}" rel="http://www.sap.com/cts/relations/adturi" type="application/vnd.sap.adt.transportrequests.v1+xml" title="Transport Organizer ADT URI" xmlns:atom="http://www.w3.org/2005/Atom"/>`

const tmObject = (type: string, name: string, info: string, desc = "") =>
  `<tm:abap_object tm:pgmid="R3TR" tm:type="${type}" tm:name="${name}" tm:wbtype="${type}" tm:obj_info="${info}"${desc ? ` tm:obj_desc="${desc}"` : ""} tm:position="000001" tm:lock_status="X" tm:img_activity="">${tmLinks("NPLK900061")}</tm:abap_object>`

/** Transport organizer document of a request with one task (structure as returned by SAP). */
export const transportDocument = `<?xml version="1.0" encoding="utf-8"?>
<tm:root tm:object_type="R" adtcore:name="NPLK900060" adtcore:type="RQRQ" adtcore:changedAt="2026-10-15T13:14:45Z" adtcore:changedBy="OTHER" adtcore:createdBy="OTHER" xmlns:tm="http://www.sap.com/cts/adt/tm" ${ADTCORE}>
${tmLinks("NPLK900060")}
<tm:request tm:number="NPLK900060" tm:parent="" tm:owner="OTHER" tm:desc="Demo app &amp; package" tm:type="K" tm:status="D" tm:status_text="Modifiable" tm:target="/NPL/" tm:target_desc="Target group" tm:source_client="001" tm:lastchanged_timestamp="20261015131445" tm:uri="/sap/bc/adt/cts/transportrequests/NPLK900060">
<tm:long_desc/>
${tmLinks("NPLK900060")}
<tm:all_objects>
${tmObject("WAPA", "ZDEMO_APP", "BSP (Business Server Pages) Application", "Demo app")}
${tmObject("DEVC", "ZDEMO", "Package", "Demo package")}
</tm:all_objects>
<tm:task tm:number="NPLK900061" tm:parent="NPLK900060" tm:owner="OTHER" tm:desc="Demo app &amp; package" tm:type="Development/Correction" tm:status="D" tm:status_text="Modifiable" tm:target="" tm:source_client="001" tm:lastchanged_timestamp="20261017000226" tm:uri="/sap/bc/adt/cts/transportrequests/NPLK900061">
<tm:long_desc/>
${tmLinks("NPLK900061")}
${tmObject("WAPA", "ZDEMO_APP", "BSP (Business Server Pages) Application", "Demo app")}
${tmObject("DEVC", "ZDEMO", "Package", "Demo package")}
</tm:task>
<tm:task tm:number="NPLK900062" tm:parent="NPLK900060" tm:owner="DEVELOPER" tm:desc="Demo app &amp; package" tm:type="Development/Correction" tm:status="D" tm:status_text="Modifiable" tm:target="" tm:source_client="001" tm:lastchanged_timestamp="20261017000226" tm:uri="/sap/bc/adt/cts/transportrequests/NPLK900062">
<tm:long_desc/>
</tm:task>
</tm:request>
</tm:root>`

export const odataV4Metadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="com.example.demo.v0001" Alias="SAP__self" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OrderType">
        <Key><PropertyRef Name="Warehouse"/><PropertyRef Name="OrderId"/></Key>
        <Property Name="Warehouse" Type="Edm.String" Nullable="false" MaxLength="4"/>
        <Property Name="OrderId" Type="Edm.String" Nullable="false" MaxLength="10"/>
        <Property Name="CreatedAt" Type="Edm.DateTimeOffset" Precision="7"/>
        <NavigationProperty Name="_Task" Type="Collection(com.example.demo.v0001.TaskType)" Partner="_Order"/>
      </EntityType>
      <EntityType Name="TaskType">
        <Key><PropertyRef Name="TaskId"/></Key>
        <Property Name="TaskId" Type="Edm.String" Nullable="false" MaxLength="12"/>
        <Property Name="Quantity" Type="Edm.Decimal" Precision="31" Scale="14"/>
      </EntityType>
      <Action Name="ConfirmTask" IsBound="true">
        <Parameter Name="_it" Type="com.example.demo.v0001.TaskType" Nullable="false"/>
        <Parameter Name="Quantity" Type="Edm.Decimal"/>
        <ReturnType Type="com.example.demo.v0001.TaskType" Nullable="false"/>
      </Action>
      <EntityContainer Name="Container">
        <EntitySet Name="Order" EntityType="com.example.demo.v0001.OrderType"/>
        <EntitySet Name="Task" EntityType="com.example.demo.v0001.TaskType"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

export const odataV2Metadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="ZDEMO_SRV" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="Product">
        <Key><PropertyRef Name="Product"/></Key>
        <Property Name="Product" Type="Edm.String" Nullable="false" MaxLength="40"/>
      </EntityType>
      <EntityContainer Name="ZDEMO_SRV_Entities" m:IsDefaultEntityContainer="true">
        <EntitySet Name="ProductSet" EntityType="ZDEMO_SRV.Product"/>
        <FunctionImport Name="Release" ReturnType="ZDEMO_SRV.Product" EntitySet="ProductSet" m:HttpMethod="POST">
          <Parameter Name="Product" Type="Edm.String" Mode="In"/>
        </FunctionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

export const dataPreview = (rows: { TRKORR: string; AS4TEXT: string }[]) => `<?xml version="1.0" encoding="utf-8"?>
<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">
  <dataPreview:totalRows>${rows.length}</dataPreview:totalRows>
  <dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>
  <dataPreview:executedQueryString>SELECT TRKORR, AS4TEXT FROM E07T</dataPreview:executedQueryString>
  <dataPreview:queryExecutionTime>1.0</dataPreview:queryExecutionTime>
  <dataPreview:columns>
    <dataPreview:metadata dataPreview:name="TRKORR" dataPreview:type="C" dataPreview:description="TRKORR" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false" dataPreview:length="20"/>
    <dataPreview:dataSet>${rows.map(r => `<dataPreview:data>${r.TRKORR}</dataPreview:data>`).join("")}</dataPreview:dataSet>
  </dataPreview:columns>
  <dataPreview:columns>
    <dataPreview:metadata dataPreview:name="AS4TEXT" dataPreview:type="C" dataPreview:description="AS4TEXT" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false" dataPreview:length="60"/>
    <dataPreview:dataSet>${rows.map(r => `<dataPreview:data>${r.AS4TEXT}</dataPreview:data>`).join("")}</dataPreview:dataSet>
  </dataPreview:columns>
</dataPreview:tableData>`
