# Internal Brain — Architecture Diagram

## System Architecture (Mermaid)

```mermaid
graph TB
    subgraph "Frontend (Browser)"
        UI[Chat UI<br/>Persona Select + S1-S5 Nav]
        AUDIT[Audit Trail Page<br/>Hash-Chain Viewer]
    end

    subgraph "Server (Express)"
        API[API Layer<br/>/api/ask, /api/refresh, /api/diary]
        ADMIN[Admin Endpoints<br/>requireAdmin middleware]
    end

    subgraph "Core Engine"
        PERMS[permissions.js<br/>Authorization Engine<br/>canAccessItem + getFilteredData]
        SEARCH[search.js<br/>Relevance Ranking<br/>Stop words + synonyms]
        ENGINE[answerEngine.js<br/>Gemini LLM<br/>Context Builder]
        DIARY[diary.js<br/>Hash-Chain Audit<br/>SHA-256 fingerprinting]
    end

    subgraph "Data Layer"
        DS[dataStore.js<br/>5-min Cache<br/>Live/Mock Switch]
        CONN[Connectors]
    end

    subgraph "Connectors (4 Platforms)"
        SLACK[slackConnector.js<br/>Slack Web API]
        JIRA[jiraConnector.js<br/>Jira REST API v3]
        CONF[confluenceConnector.js<br/>Confluence REST API]
        DRIVE[driveConnector.js<br/>Google Drive API]
    end

    subgraph "External APIs"
        S_API[Slack API]
        J_API[Jira API]
        C_API[Confluence API]
        D_API[Google Drive API]
        GEMINI[Google Gemini<br/>LLM API]
    end

    subgraph "Mock Data (JSON)"
        M_SLACK[data/slack.json]
        M_JIRA[data/jira.json]
        M_CONF[data/wiki.json]
        M_DRIVE[data/drive.json]
    end

    UI -->|HTTP| API
    AUDIT -->|HTTP| API
    API --> ADMIN

    API -->|1. Filter| PERMS
    API -->|2. Search| SEARCH
    API -->|3. Build Context| ENGINE
    API -->|4. Log| DIARY

    PERMS -->|loadAllApps| DS
    DS --> CONN
    CONN --> SLACK
    CONN --> JIRA
    CONN --> CONF
    CONN --> DRIVE

    SLACK -->|LIVE| S_API
    JIRA -->|LIVE| J_API
    CONF -->|LIVE| C_API
    DRIVE -->|LIVE| D_API

    SLACK -->|MOCK| M_SLACK
    JIRA -->|MOCK| M_JIRA
    CONF -->|MOCK| M_CONF
    DRIVE -->|MOCK| M_DRIVE

    ENGINE -->|Authorized Context| GEMINI
    GEMINI -->|Grounded Answer| ENGINE
```

## Permission Flow (Mermaid)

```mermaid
sequenceDiagram
    participant U as User
    participant S as Server
    participant P as Permissions Engine
    participant SE as Search Engine
    participant AE as Answer Engine (Gemini)
    participant D as Diary (Audit)

    U->>S: POST /api/ask {userId, query}
    S->>P: getFilteredData(userId)
    P->>P: canAccessItem() for EVERY item
    P-->>S: filtered data (authorized only)
    Note over P,S: Denied items never reach search or LLM
    
    S->>SE: searchItems(filtered, query)
    SE-->>S: ranked results (authorized only)
    
    S->>AE: buildAuthorizedContext(results, user)
    AE->>AE: Build prompt with authorized context only
    AE->>AE: Call Gemini API
    AE-->>S: answer + citations + sources
    
    S->>D: appendEntry({query, answer, sources, deniedItems, provenance, ...})
    D->>D: SHA-256 fingerprint chain
    D-->>S: entry index
    
    S-->>U: {answer, sources, provenance, auditEntryIndex}
    Note over S,U: Denied items count NOT shown to user (only in audit trail)
```

## S4 Permission Change Flow (Mermaid)

```mermaid
sequenceDiagram
    participant U as Admin
    participant S as Server
    participant P as Permissions
    participant D as Diary

    U->>S: PUT /api/permissions/:userId/resource/:app/:id {action: deny}
    S->>S: requireAdmin middleware (check x-admin-user-id)
    S->>P: Update overrides[userId][app].deniedItems
    P->>P: Save permissions.json
    P->>P: Invalidate cache (refreshLiveCache)
    S->>D: appendEntry({permissionChange: RESOURCE_OVERRIDE, actor, ...})
    S-->>U: {success, action: deny}

    Note over U: User asks same question again
    U->>S: POST /api/ask {userId, query}
    S->>P: getFilteredData(userId)
    Note over P: Denied resource is EXCLUDED
    S-->>U: Answer WITHOUT denied resource in sources
```

## Three-Tier Resource Tracking

```mermaid
graph LR
    A[All Items in Data Store] -->|getFilteredData| B{canAccessItem?}
    B -->|ALLOW| C[Authorized Items]
    B -->|DENY| D[Denied Items<br/>logged to audit]
    
    C -->|searchItems| E[Search Results]
    E -->|buildAuthorizedContext| F[Sent to LLM]
    
    D -.->|logged| G[Audit: deniedItems + reasons]
    C -.->|logged| H[Audit: authorizedResources]
    F -.->|logged| I[Audit: sentToLlmResources]
    
    F -->|Gemini response| J[Answer + Citations]
    J -.->|logged| K[Audit: citations]
```
