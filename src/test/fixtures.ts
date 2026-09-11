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

const request = (trkorr: string, text: string) => `<CTS_REQUEST><REQ_HEADER><TRKORR>${trkorr}</TRKORR><TRFUNCTION>K</TRFUNCTION><TRSTATUS>D</TRSTATUS><TARSYSTEM>NPL</TARSYSTEM><AS4USER>DEVELOPER</AS4USER><AS4DATE>20260901</AS4DATE><AS4TIME>100000</AS4TIME><AS4TEXT>${text}</AS4TEXT><CLIENT>001</CLIENT></REQ_HEADER><TASK_HEADERS/></CTS_REQUEST>`

export const transportChecks = (dlvunit = "HOME", requests = [request("NPLK900010", "Demo transport"), request("NPLK900020", "Other transport")]) =>
  `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>
<PGMID>R3TR</PGMID><OBJECT>CLAS</OBJECT><OBJECTNAME>ZCL_DEMO</OBJECTNAME><OPERATION/><DEVCLASS>ZDEMO</DEVCLASS><CTEXT>Demo package</CTEXT><KORRFLAG>X</KORRFLAG><AS4USER>DEVELOPER</AS4USER><PDEVCLASS/><DLVUNIT>${dlvunit}</DLVUNIT><NAMESPACE/><RESULT>S</RESULT><RECORDING>X</RECORDING><EXISTING_REQ_ONLY/>
<REQUESTS>${requests.join("")}</REQUESTS><LOCKS/>
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
