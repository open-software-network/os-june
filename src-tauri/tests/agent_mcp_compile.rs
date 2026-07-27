use os_june_lib::agent_mcp::{
    runtime_tool_name, AgentMcpRepository, AgentMcpSubsystem, KeychainMcpSecretStore,
    McpServerDefinition, McpTransport,
};

#[test]
fn public_mcp_surface_compiles_after_host_integration() {
    let server = McpServerDefinition::new("example", McpTransport::Stdio);
    assert_eq!(server.name, "example");
    assert_eq!(
        runtime_tool_name("example", "read item").unwrap(),
        "mcp_example_read_item"
    );
    let _ = std::mem::size_of::<AgentMcpRepository>();
    let _ = std::mem::size_of::<AgentMcpSubsystem<KeychainMcpSecretStore>>();
}
